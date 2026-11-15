// @vitest-environment jsdom
/**
 * Each queued share gets a fresh picker: the real ShareTargetPickerModal,
 * mounted by the controller, must not carry the previous share's search or
 * New chat step into the next share.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  NativeCommandResult,
  NativeImageList,
} from '../platform/native/types';

const native = vi.hoisted(() => ({ adapter: null as unknown }));

vi.mock('../platform/native', () => ({
  get nativePlatformPromise() {
    return Promise.resolve(native.adapter);
  },
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'agent-one', name: 'Agent One' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../hooks/useShareToConversation', () => ({
  useShareToConversation: () => vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  fetchAgentConversations: async () => [
    {
      id: 'c1',
      title: 'Design review',
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: '2026-11-07T10:00:00.000Z',
    },
  ],
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => ({
    data: [{ slug: 'alpha', name: 'Alpha project' }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { ShareIntakeController } from '../components/chat/ShareIntakeController';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const file = (name: string) => ({
  name,
  mimeType: 'image/png' as const,
  dataUrl: PNG,
});

afterEach(cleanup);

test('a queued share opens a fresh picker, not the last share’s state', async () => {
  const takes: Array<NativeCommandResult<NativeImageList>> = [
    { status: 'ok', value: { files: [file('one.png'), file('two.png')] } },
    { status: 'ok', value: { files: [file('three.png')] } },
  ];
  let nudge = () => {};
  native.adapter = {
    capability: (id: string) => ({ id, state: 'enabled', reason: 'fixture' }),
    takeSharedImages: async () =>
      takes.shift() ?? { status: 'ok', value: { files: [] } },
    subscribeToSharedImages: (listener: () => void) => {
      nudge = listener;
      return { ready: Promise.resolve(), dispose() {} };
    },
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShareIntakeController />
    </QueryClientProvider>,
  );

  await screen.findByText('Choose a conversation for 2 shared images');
  fireEvent.change(screen.getByLabelText('Search chats'), {
    target: { value: 'design' },
  });
  fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
  fireEvent.change(screen.getByLabelText('Search projects'), {
    target: { value: 'alp' },
  });

  // A second share lands while the first picker is open.
  await act(async () => nudge());
  expect(
    screen.getByText('Choose a project for a new chat with 2 shared images'),
  ).not.toBeNull();

  // The first picker is dismissed; the queued share takes its place.
  fireEvent.keyDown(document, { key: 'Escape' });
  await screen.findByText('Choose a conversation for the shared image');
  const search = screen.getByLabelText('Search chats') as HTMLInputElement;
  expect(search.value).toBe('');
  expect(await screen.findByText('Design review')).not.toBeNull();
});
