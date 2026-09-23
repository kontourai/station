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

const { createProjectMock, mutateJsonMock, setProjectMock } = vi.hoisted(
  () => ({
    createProjectMock: vi.fn(),
    mutateJsonMock: vi.fn(),
    setProjectMock: vi.fn(),
  }),
);

// The two network seams the flow owns: Project creation through the SDK's
// mutation, and the scaffold POST through the SDK's request primitive.
vi.mock('@kontourai/station-sdk', () => ({
  useCreateProjectMutation: () => ({
    mutateAsync: createProjectMock,
    isPending: false,
  }),
  mutateJson: mutateJsonMock,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setProject: setProjectMock }),
}));
// The folder field's own suggestions read the filesystem browse route; a
// plain input keeps this test on the flow rather than on autocomplete.
vi.mock('../../../components/PathAutocomplete', () => ({
  PathAutocomplete: ({
    id,
    value,
    onChange,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const { NewPluginModal } = await import('../NewPluginModal');

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
  createProjectMock.mockReset();
  mutateJsonMock.mockReset();
  setProjectMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderModal(onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NewPluginModal onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

function captureProjectChatRequests(): OpenProjectChatsDetail[] {
  const requests: OpenProjectChatsDetail[] = [];
  const listener = (event: Event) =>
    requests.push((event as CustomEvent<OpenProjectChatsDetail>).detail);
  window.addEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
  chatListeners.push(listener);
  return requests;
}

test('creates the Project, then scaffolds into it, opens it, and offers a primed chat', async () => {
  createProjectMock.mockResolvedValue({
    slug: 'pulse-board',
    name: 'Pulse Board',
  });
  mutateJsonMock.mockResolvedValue(
    jsonResponse(201, {
      success: true,
      data: {
        name: 'pulse-board',
        template: 'pane',
        displayName: 'Pulse Board',
        files: ['plugin.json'],
      },
    }),
  );
  const chatRequests = captureProjectChatRequests();
  const onClose = renderModal();

  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse-board' },
  });
  fireEvent.change(screen.getByLabelText(/^Folder/), {
    target: { value: '/work/pulse/' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());

  expect(createProjectMock).toHaveBeenCalledWith({
    name: 'Pulse Board',
    slug: 'pulse-board',
    workingDirectory: '/work/pulse',
  });
  expect(mutateJsonMock).toHaveBeenCalledWith(
    'http://station.test/api/projects/pulse-board/plugin-scaffold',
    'POST',
    undefined,
    { name: 'pulse-board', template: 'pane', displayName: 'Pulse Board' },
  );
  // The scaffold needs the Project's folder, so it can only follow creation.
  expect(createProjectMock.mock.invocationCallOrder[0]).toBeLessThan(
    mutateJsonMock.mock.invocationCallOrder[0],
  );
  expect(setProjectMock).toHaveBeenCalledWith('pulse-board');

  expect(chatRequests).toHaveLength(1);
  const [request] = chatRequests;
  expect(request).toMatchObject({
    projectSlug: 'pulse-board',
    projectName: 'Pulse Board',
    source: 'new-plugin',
  });
  const message = request.composerDraft?.message ?? '';
  expect(message).toContain('`plugin-authoring`');
  expect(message).toContain('`validate_plugin`');
  expect(message).toContain("Don't install, update or remove plugins");
  // Offered for the composer, not sent: the text says so to the person.
  expect(request.composerDraft?.description).toMatch(/nothing is sent/);
});

test('a refused scaffold names what is in the folder, and Retry reuses the created Project', async () => {
  createProjectMock.mockResolvedValue({ slug: 'pulse', name: 'Pulse' });
  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(409, {
      success: false,
      code: 'working-directory-not-empty',
      error: "The Project's folder is not empty",
      entries: ['notes.md'],
      entryCount: 1,
    }),
  );
  const chatRequests = captureProjectChatRequests();
  const onClose = renderModal();

  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    'It contains: notes.md',
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(setProjectMock).not.toHaveBeenCalled();
  expect(chatRequests).toHaveLength(0);

  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(201, {
      success: true,
      data: {
        name: 'pulse',
        template: 'pane',
        displayName: 'Pulse',
        files: [],
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(createProjectMock).toHaveBeenCalledTimes(1);
  expect(mutateJsonMock).toHaveBeenCalledTimes(2);
  expect(setProjectMock).toHaveBeenCalledWith('pulse');
});

test('an invalid plugin name is explained and cannot be submitted', () => {
  renderModal();
  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'My Plugin' },
  });
  expect(screen.getByText(/Use lowercase letters/)).toBeTruthy();
  const create = screen.getByRole('button', {
    name: 'Create plugin',
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.click(create);
  expect(createProjectMock).not.toHaveBeenCalled();
});
