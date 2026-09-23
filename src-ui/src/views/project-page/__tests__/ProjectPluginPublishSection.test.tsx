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

const { getJsonMock, mutateJsonMock, copyMock } = vi.hoisted(() => ({
  getJsonMock: vi.fn(),
  mutateJsonMock: vi.fn(),
  copyMock: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  getJson: getJsonMock,
  mutateJson: mutateJsonMock,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: copyMock }));

const { ProjectPluginPublishSection } = await import(
  '../ProjectPluginPublishSection'
);

const ENDPOINT = 'http://station.test/api/projects/pulse/plugin-publish';
const REMOTE = 'https://github.com/acme/pulse.git';

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

afterEach(() => {
  cleanup();
  getJsonMock.mockReset();
  mutateJsonMock.mockReset();
  copyMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    plugin: { name: 'pulse', version: '1.0.0' },
    repository: { state: 'none' },
    changes: [
      { path: 'plugin.json', status: '??' },
      { path: 'index.ts', status: '??' },
    ],
    secrets: [],
    tooManyChanges: false,
    ...overrides,
  };
}

function answerInspection(data: unknown, status = 200) {
  getJsonMock.mockImplementation(async () =>
    status === 200
      ? jsonResponse(200, { success: true, data })
      : jsonResponse(status, { success: false, error: 'refused' }),
  );
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectPluginPublishSection slug="pulse" />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Publish to git…' }),
  );
  return screen.findByRole('dialog');
}

test('a caller the server refuses (not the operator) is offered nothing', async () => {
  answerInspection(null, 403);
  const { container } = renderSection();
  await waitFor(() => expect(getJsonMock).toHaveBeenCalledWith(ENDPOINT));
  expect(container.innerHTML).toBe('');
});

test('a folder without a plugin is offered nothing', async () => {
  answerInspection({ plugin: null, reason: 'not-a-plugin' });
  const { container } = renderSection();
  await waitFor(() => expect(getJsonMock).toHaveBeenCalled());
  expect(container.innerHTML).toBe('');
});

test('publishes to a new remote with the edited message and shows the install source to copy', async () => {
  answerInspection(inspection());
  mutateJsonMock.mockResolvedValue(
    jsonResponse(201, {
      success: true,
      data: {
        plugin: { name: 'pulse', version: '1.0.0' },
        commit: 'abc123',
        branch: 'main',
        remote: { name: 'origin', url: REMOTE },
        installSource: REMOTE,
        installSourceDerived: false,
        installCommand: `station plugin install ${REMOTE}`,
      },
    }),
  );
  copyMock.mockResolvedValue(true);
  renderSection();
  await openDialog();

  // What will be published, before anything happens.
  expect(screen.getByText('2 files will be committed')).toBeTruthy();
  expect(screen.getByText('plugin.json')).toBeTruthy();
  expect(
    screen.getByText(/not a git repository yet. Publishing runs git init/),
  ).toBeTruthy();

  const publish = screen.getByRole('button', { name: 'Commit and push' });
  // No address yet: nothing to push to.
  expect((publish as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Repository address'), {
    target: { value: REMOTE },
  });
  fireEvent.change(screen.getByLabelText('Commit message'), {
    target: { value: 'First release' },
  });
  fireEvent.click(publish);

  await screen.findByText('Plugin published');
  expect(mutateJsonMock).toHaveBeenCalledWith(ENDPOINT, 'POST', undefined, {
    message: 'First release',
    remoteName: 'origin',
    remoteUrl: REMOTE,
  });
  expect(
    (screen.getByLabelText('Install source') as HTMLInputElement).value,
  ).toBe(REMOTE);
  expect(
    (screen.getByLabelText('Install with the CLI') as HTMLInputElement).value,
  ).toBe(`station plugin install ${REMOTE}`);
  fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
  await screen.findByText('Copied.');
  expect(copyMock).toHaveBeenCalledWith(REMOTE);
});

test('an existing usable remote is chosen by default and sent by name only', async () => {
  answerInspection(
    inspection({
      repository: {
        state: 'root',
        branch: 'main',
        hasCommits: true,
        remotes: [
          {
            name: 'origin',
            url: REMOTE,
            usable: true,
            installSource: REMOTE,
            installSourceDerived: false,
          },
        ],
      },
    }),
  );
  mutateJsonMock.mockResolvedValue(
    jsonResponse(409, {
      success: false,
      code: 'push-rejected',
      error: 'The remote has commits this folder does not.',
    }),
  );
  renderSection();
  await openDialog();
  expect(
    (screen.getByRole('radio', { name: /origin/ }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }));
  expect(
    await screen.findByText('The remote has commits this folder does not.'),
  ).toBeTruthy();
  expect(mutateJsonMock).toHaveBeenCalledWith(ENDPOINT, 'POST', undefined, {
    message: 'Publish pulse 1.0.0',
    remoteName: 'origin',
  });
});

test('a remote carrying a token cannot be chosen', async () => {
  answerInspection(
    inspection({
      repository: {
        state: 'root',
        branch: 'main',
        hasCommits: true,
        remotes: [
          {
            name: 'origin',
            url: 'https://github.com/acme/pulse.git',
            usable: false,
            refusal: 'credentials-in-url',
          },
        ],
      },
    }),
  );
  renderSection();
  await openDialog();
  expect(
    (screen.getByRole('radio', { name: /origin/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByText(/its address holds a password or token/),
  ).toBeTruthy();
  expect(
    (screen.getByRole('radio', { name: 'A new remote' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test('files that look like secrets are listed and block publishing', async () => {
  answerInspection(
    inspection({ secrets: [{ path: '.env', reason: 'environment file' }] }),
  );
  renderSection();
  await openDialog();
  fireEvent.change(screen.getByLabelText('Repository address'), {
    target: { value: REMOTE },
  });
  expect(screen.getByText('.env')).toBeTruthy();
  expect(screen.getByText(/look like secrets/)).toBeTruthy();
  expect(
    (
      screen.getByRole('button', {
        name: 'Commit and push',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test('a secret the server finds at publish time is listed too', async () => {
  answerInspection(inspection());
  mutateJsonMock.mockResolvedValue(
    jsonResponse(409, {
      success: false,
      code: 'secrets',
      error: 'Some files that would be committed look like secrets.',
      secrets: [{ path: 'notes.txt', reason: 'contains a private key' }],
    }),
  );
  renderSection();
  await openDialog();
  fireEvent.change(screen.getByLabelText('Repository address'), {
    target: { value: REMOTE },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }));
  expect(await screen.findByText('notes.txt')).toBeTruthy();
  expect(screen.getByText(/contains a private key/)).toBeTruthy();
});

test('a folder inside another repository explains why and cannot publish', async () => {
  answerInspection(
    inspection({ repository: { state: 'nested' }, changes: [] }),
  );
  renderSection();
  await openDialog();
  expect(screen.getByText(/inside another git repository/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Repository address'), {
    target: { value: REMOTE },
  });
  expect(
    (
      screen.getByRole('button', {
        name: 'Commit and push',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
