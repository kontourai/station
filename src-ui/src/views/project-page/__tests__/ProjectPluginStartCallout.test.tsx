/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  OPEN_PROJECT_CHATS_EVENT,
  type OpenProjectChatsDetail,
} from '../../../lib/projectChatEvents';

const { getJsonMock, mutateJsonMock, setDockStateMock } = vi.hoisted(() => ({
  getJsonMock: vi.fn(),
  mutateJsonMock: vi.fn(),
  setDockStateMock: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  getJson: getJsonMock,
  mutateJson: mutateJsonMock,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setProject: vi.fn(),
    setDockState: setDockStateMock,
  }),
}));

const { ProjectPluginStartCallout } = await import(
  '../ProjectPluginStartCallout'
);

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

const chatListeners: ((event: Event) => void)[] = [];
afterEach(() => {
  for (const listener of chatListeners.splice(0))
    window.removeEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
  cleanup();
  getJsonMock.mockReset();
  mutateJsonMock.mockReset();
  setDockStateMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderCallout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectPluginStartCallout project={{ slug: 'shared', name: 'Shared' }} />
    </QueryClientProvider>,
  );
}

test('an empty Project folder offers to start a plugin, scaffolds into it, and primes a chat', async () => {
  getJsonMock.mockResolvedValue(
    jsonResponse(200, { success: true, data: { eligible: true } }),
  );
  mutateJsonMock.mockResolvedValue(
    jsonResponse(201, {
      success: true,
      data: {
        name: 'shared-pulse',
        template: 'pane',
        displayName: 'Shared Pulse',
        files: ['plugin.json'],
      },
    }),
  );
  const requests: OpenProjectChatsDetail[] = [];
  const listener = (event: Event) =>
    requests.push((event as CustomEvent<OpenProjectChatsDetail>).detail);
  window.addEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
  chatListeners.push(listener);

  renderCallout();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Start a plugin' }),
  );
  expect(getJsonMock).toHaveBeenCalledWith(
    'http://station.test/api/projects/shared/plugin-scaffold',
  );

  fireEvent.change(await screen.findByLabelText('Plugin name'), {
    target: { value: 'shared-pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start plugin' }));

  await waitFor(() => expect(requests).toHaveLength(1));
  // Into THIS Project; no Project is created.
  expect(mutateJsonMock).toHaveBeenCalledWith(
    'http://station.test/api/projects/shared/plugin-scaffold',
    'POST',
    undefined,
    { name: 'shared-pulse', template: 'pane', displayName: 'Shared Pulse' },
  );
  expect(setDockStateMock).toHaveBeenCalledWith(true);
  expect(requests[0]).toMatchObject({
    projectSlug: 'shared',
    source: 'new-plugin',
  });
  expect(requests[0].composerDraft?.message).toContain('`validate_plugin`');
});

test('a folder that cannot take a scaffold offers nothing', async () => {
  getJsonMock.mockResolvedValue(
    jsonResponse(200, {
      success: true,
      data: { eligible: false, reason: 'working-directory-not-empty' },
    }),
  );
  renderCallout();
  await waitFor(() => expect(getJsonMock).toHaveBeenCalled());
  // Let the query settle before asserting absence.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole('button', { name: 'Start a plugin' })).toBeNull();
});
