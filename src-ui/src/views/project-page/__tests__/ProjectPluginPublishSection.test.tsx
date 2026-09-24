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
const SUMMARY = `${ENDPOINT}?view=summary`;
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
    files: [
      { path: 'index.ts', size: 11 },
      { path: 'plugin.json', size: 40 },
    ],
    skipped: [],
    secrets: [],
    refusal: null,
    ...overrides,
  };
}

/** Answers the summary (asked on mount) from the same fixture as the full
 * inspection (asked when the dialog opens), the way the server derives
 * both from one folder. */
function answerInspection(data: unknown, status = 200) {
  getJsonMock.mockImplementation(async (url: string) => {
    if (status !== 200) {
      return jsonResponse(status, { success: false, error: 'refused' });
    }
    if (url === SUMMARY) {
      const plugin = (data as { plugin: unknown }).plugin;
      return jsonResponse(200, {
        success: true,
        data: plugin ? { plugin } : data,
      });
    }
    if (url === ENDPOINT) return jsonResponse(200, { success: true, data });
    throw new Error(`unexpected request ${url}`);
  });
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ProjectPluginPublishSection slug="pulse" />
    </QueryClientProvider>,
  );
  /** Waits until the summary query has SETTLED, so an assertion that
   * nothing rendered is about the answer, not about a pending request. */
  const settled = (status: 'error' | 'success') =>
    waitFor(() =>
      expect(
        queryClient.getQueryState([
          'plugin-publish-summary',
          'http://station.test',
          'pulse',
        ])?.status,
      ).toBe(status),
    );
  return { ...rendered, settled };
}

async function openDialog() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Publish to git…' }),
  );
  // The inspection dialog, not the "Checking the folder" one before it.
  await screen.findByRole('button', { name: 'Publish' });
  return screen.getByRole('dialog');
}

function publishButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
}

function typeAddress(value = REMOTE) {
  fireEvent.change(screen.getByLabelText('Repository address'), {
    target: { value },
  });
}

test('a caller the server refuses (not the operator) is offered nothing', async () => {
  answerInspection(null, 403);
  const { container, settled } = renderSection();
  await settled('error');
  expect(getJsonMock).toHaveBeenCalledWith(SUMMARY);
  expect(container.innerHTML).toBe('');
});

test('a folder without a plugin is offered nothing', async () => {
  answerInspection({ plugin: null, reason: 'not-a-plugin' });
  const { container, settled } = renderSection();
  await settled('success');
  expect(container.innerHTML).toBe('');
});

test('viewing the Project asks only the summary; the folder is walked when the dialog opens', async () => {
  answerInspection(inspection());
  const { settled } = renderSection();
  await settled('success');
  await screen.findByRole('button', { name: 'Publish to git…' });
  expect(getJsonMock.mock.calls.map(([url]) => url)).toEqual([SUMMARY]);
  await openDialog();
  expect(getJsonMock.mock.calls.map(([url]) => url)).toEqual([
    SUMMARY,
    ENDPOINT,
  ]);
});

test('publishes with the address, branch and message typed, and shows the install source to copy', async () => {
  answerInspection(
    inspection({
      skipped: [{ path: 'linked.ts', reason: 'symbolic-link' }],
    }),
  );
  mutateJsonMock.mockResolvedValue(
    jsonResponse(201, {
      success: true,
      data: {
        plugin: { name: 'pulse', version: '1.0.0' },
        commit: 'abc123def4567890',
        parent: null,
        branch: 'release',
        remoteUrl: REMOTE,
        committer: { name: 'Station Operator', email: 'op@example.test' },
        files: 2,
        skipped: [],
        installSource: `${REMOTE}#release`,
        installSourceDerived: false,
        installCommand: `station plugin install ${REMOTE}#release`,
      },
    }),
  );
  copyMock.mockResolvedValue(true);
  renderSection();
  await openDialog();

  // What will be published, before anything happens.
  expect(screen.getByText('2 files will be published')).toBeTruthy();
  expect(screen.getByText('plugin.json')).toBeTruthy();
  expect(screen.getByText('linked.ts')).toBeTruthy();
  expect(screen.getByText(/Station does not follow links/)).toBeTruthy();

  // No address yet: nothing to push to.
  expect(publishButton().disabled).toBe(true);
  typeAddress();
  fireEvent.change(screen.getByLabelText('Branch'), {
    target: { value: 'release' },
  });
  fireEvent.change(screen.getByLabelText('Commit message'), {
    target: { value: 'First release' },
  });
  fireEvent.click(publishButton());

  await screen.findByText('Plugin published');
  expect(mutateJsonMock).toHaveBeenCalledWith(ENDPOINT, 'POST', undefined, {
    remoteUrl: REMOTE,
    branch: 'release',
    message: 'First release',
  });
  expect(
    screen.getByText(/Commit abc123def456 by Station Operator/),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText('Install source') as HTMLInputElement).value,
  ).toBe(`${REMOTE}#release`);
  expect(
    (screen.getByLabelText('Install with the CLI') as HTMLInputElement).value,
  ).toBe(`station plugin install ${REMOTE}#release`);
  fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
  await screen.findByText('Copied.');
  expect(copyMock).toHaveBeenCalledWith(`${REMOTE}#release`);
});

test('files that look like secrets are listed and block publishing', async () => {
  answerInspection(
    inspection({
      secrets: [{ path: '.env', reason: 'environment file' }],
      refusal: { code: 'secrets', message: 'look like secrets' },
    }),
  );
  renderSection();
  await openDialog();
  typeAddress();
  expect(screen.getByText('.env')).toBeTruthy();
  expect(
    screen.getByText(/look like secrets and would be published/),
  ).toBeTruthy();
  expect(publishButton().disabled).toBe(true);
});

test('a folder refusal is explained with the files it names, and blocks publishing', async () => {
  answerInspection(
    inspection({
      refusal: {
        code: 'filter-attributes',
        message:
          'A .gitattributes file assigns a git filter (such as Git LFS).',
        paths: ['assets/.gitattributes'],
      },
    }),
  );
  renderSection();
  await openDialog();
  typeAddress();
  expect(screen.getByText(/assigns a git filter/)).toBeTruthy();
  expect(screen.getByText('assets/.gitattributes')).toBeTruthy();
  expect(publishButton().disabled).toBe(true);
});

test('a refusal at publish time shows the server sentence, and a secret it found is listed', async () => {
  answerInspection(inspection());
  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(409, {
      success: false,
      code: 'remote-moved',
      error: 'The branch on the remote changed while publishing.',
    }),
  );
  renderSection();
  await openDialog();
  typeAddress();
  fireEvent.click(publishButton());
  expect(
    await screen.findByText(
      'The branch on the remote changed while publishing.',
    ),
  ).toBeTruthy();

  mutateJsonMock.mockResolvedValueOnce(
    jsonResponse(409, {
      success: false,
      code: 'secrets',
      error: 'Some files look like secrets.',
      secrets: [{ path: 'notes.txt', reason: 'contains a private key' }],
    }),
  );
  fireEvent.click(publishButton());
  expect(await screen.findByText('notes.txt')).toBeTruthy();
  expect(screen.getByText(/contains a private key/)).toBeTruthy();
});
