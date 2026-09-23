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

const {
  createProjectMock,
  mutateJsonMock,
  setProjectMock,
  setDockStateMock,
  stationConfig,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  mutateJsonMock: vi.fn(),
  setProjectMock: vi.fn(),
  setDockStateMock: vi.fn(),
  stationConfig: { value: null as Record<string, unknown> | null },
}));

// The two network seams the flow owns: Project creation through the SDK's
// mutation, and the scaffold POST through the SDK's request primitive.
vi.mock('@kontourai/station-sdk', () => ({
  useCreateProjectMutation: () => ({
    mutateAsync: createProjectMock,
    isPending: false,
  }),
  mutateJson: mutateJsonMock,
  getJson: vi.fn(),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../contexts/ConfigContext', () => ({
  useConfig: () => stationConfig.value,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setProject: setProjectMock,
    setDockState: setDockStateMock,
  }),
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
const { WORKTREE_OVERRIDE_REFUSED } = await import('../useNewPluginFlow');

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
  setDockStateMock.mockReset();
  stationConfig.value = null;
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

/**
 * Stands in for the mounted chat dock. By default it claims the request, as
 * the dock does; `claim: false` is a screen with no chat pane that can.
 */
function captureProjectChatRequests({
  claim = true,
}: {
  claim?: boolean;
} = {}): OpenProjectChatsDetail[] {
  const requests: OpenProjectChatsDetail[] = [];
  const listener = (event: Event) => {
    requests.push((event as CustomEvent<OpenProjectChatsDetail>).detail);
    if (claim) event.preventDefault();
  };
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
  // D2: the Station default is not worktree (config unread here), so no
  // isolation override is sent; writing one needs operate scope.
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
  // The picker renders inside the dock shell, so the dock is revealed.
  expect(setDockStateMock).toHaveBeenCalledWith(true);

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

test('a refused scaffold says how much is in the folder, and Retry reuses the created Project', async () => {
  createProjectMock.mockResolvedValue({ slug: 'pulse', name: 'Pulse' });
  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(409, {
      success: false,
      code: 'working-directory-not-empty',
      error: "The Project's folder is not empty",
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
    'It holds 1 item.',
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(setProjectMock).not.toHaveBeenCalled();
  expect(chatRequests).toHaveLength(0);
  // The Project exists, so the person can go to it instead of retrying.
  expect(screen.getByRole('button', { name: 'Open Project' })).toBeTruthy();

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

test('after a partial scaffold, Open Project goes to the created Project', async () => {
  createProjectMock.mockResolvedValue({ slug: 'pulse', name: 'Pulse' });
  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(409, {
      success: false,
      code: 'partial-scaffold',
      error: 'Part of this plugin is already in the Project folder',
      presentCount: 2,
      missingCount: 6,
    }),
  );
  const onClose = renderModal();
  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    '2 files of this plugin are already there.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Project' }));
  expect(setProjectMock).toHaveBeenCalledWith('pulse');
  expect(onClose).toHaveBeenCalled();
});

test('under a worktree Station default, the Project is created with shared isolation', async () => {
  stationConfig.value = { defaultWorkspaceIsolation: 'worktree' };
  createProjectMock.mockResolvedValue({ slug: 'pulse', name: 'Pulse' });
  mutateJsonMock.mockResolvedValue(
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
  captureProjectChatRequests();
  const onClose = renderModal();
  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(createProjectMock).toHaveBeenCalledWith({
    name: 'Pulse',
    slug: 'pulse',
    defaultWorkspaceIsolation: 'shared',
  });
});

test('when this device may not set the override, it says so plainly', async () => {
  stationConfig.value = { defaultWorkspaceIsolation: 'worktree' };
  createProjectMock.mockRejectedValue(
    Object.assign(
      new Error('The workspace new chats start in is a Station setting'),
      {
        status: 403,
      },
    ),
  );
  renderModal();
  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    WORKTREE_OVERRIDE_REFUSED,
  );
  expect(mutateJsonMock).not.toHaveBeenCalled();
});

test('when no chat pane takes the request, the opening message stays to copy', async () => {
  createProjectMock.mockResolvedValue({ slug: 'pulse', name: 'Pulse' });
  mutateJsonMock.mockResolvedValue(
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
  const requests = captureProjectChatRequests({ claim: false });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const onClose = renderModal();
  fireEvent.change(screen.getByLabelText('Plugin name'), {
    target: { value: 'pulse' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));

  expect((await screen.findByRole('alert')).textContent).toMatch(
    /Chat couldn't open here/,
  );
  expect(requests).toHaveLength(1);
  // Still open, and not navigated away yet.
  expect(onClose).not.toHaveBeenCalled();
  expect(setProjectMock).not.toHaveBeenCalled();
  const message = (
    screen.getByLabelText('Opening message') as HTMLTextAreaElement
  ).value;
  expect(message).toContain('`validate_plugin`');

  fireEvent.click(screen.getByRole('button', { name: 'Copy opening message' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
  expect((await screen.findByRole('status')).textContent).toBe('Copied.');

  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(setProjectMock).toHaveBeenCalledWith('pulse');
  expect(onClose).toHaveBeenCalled();
});

test.each([
  ['Pane and Agent', 'full'],
  ['Server provider', 'provider'],
] as const)(
  'choosing %s sends template %s to the scaffold',
  async (label, template) => {
    // I15.
    createProjectMock.mockResolvedValue({ slug: 'kit', name: 'Kit' });
    mutateJsonMock.mockResolvedValue(
      jsonResponse(201, {
        success: true,
        data: { name: 'kit', template, displayName: 'Kit', files: [] },
      }),
    );
    captureProjectChatRequests();
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText('Plugin name'), {
      target: { value: 'kit' },
    });
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(label) }));
    fireEvent.click(screen.getByRole('button', { name: 'Create plugin' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateJsonMock).toHaveBeenCalledWith(
      'http://station.test/api/projects/kit/plugin-scaffold',
      'POST',
      undefined,
      { name: 'kit', template, displayName: 'Kit' },
    );
  },
);
