/** @vitest-environment jsdom */
import {
  _setApiBase,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const flags = new Set<string>();
const apiBase = 'https://station.test';
let account = 'account-1';
const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const readTasks = vi.fn<(account: string) => Response>();
const createTask =
  vi.fn<(account: string, body: { title: string }) => Promise<Response>>();
const createReference =
  vi.fn<(taskId: string, body: unknown) => Promise<Response>>();
const updateProject = vi.fn<(body: unknown) => Promise<Response>>();
let tasks: Record<string, { id: string }[]> = {};

vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags,
}));

import {
  bindProjectContinuation,
  stageProjectContinuation,
} from '../../../lib/continue-in-project';
import { SetupRecommendationsCard } from '../SetupRecommendationsCard';

const project = { id: 'p-1', slug: 'billing', name: 'Billing' };

function captureScope() {
  const authorityKey = account;
  return { apiBase, authorityKey, isCurrent: () => account === authorityKey };
}

function mount({ hasRepository = true, description = '' } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <SetupRecommendationsCard
        requestScope={captureScope()}
        project={{ ...project, description }}
        hasRepository={hasRepository}
      />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { unmount: view.unmount, refreshScope: () => view.rerender(tree()) };
}

function offerContinuation(description: string) {
  const requestScope = captureScope();
  const draftId = stageProjectContinuation(requestScope, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    title: 'Continue: Revenue',
    description,
    savedAt: new Date().toISOString(),
  });
  expect(draftId).toBeDefined();
  bindProjectContinuation(requestScope, draftId!, project.id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const ok = (data: unknown) => Response.json({ success: true, data });

beforeEach(() => {
  flags.clear();
  flags.add('continue-in-project');
  account = 'account-1';
  tasks = {};
  localStorage.clear();
  sessionStorage.clear();
  _setApiBase(apiBase);
  setClientCredentialResolver(() => ({
    origin: apiBase,
    credential: account,
    requestAuthority: captureScope(),
  }));
  readTasks.mockReset().mockImplementation((owner) => ok(tasks[owner] ?? []));
  createTask.mockReset().mockImplementation(async (owner) => {
    tasks[owner] ??= [];
    const existing = tasks[owner];
    const task = { id: `task-${existing.length + 1}` };
    existing.push(task);
    return ok(task);
  });
  createReference.mockReset().mockImplementation(async () => ok({}));
  updateProject.mockReset().mockImplementation(async () => ok({}));
  request.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(input);
    const owner = new Headers(init?.headers)
      .get('Authorization')
      ?.replace(/^Bearer /, '');
    const method = init?.method ?? 'GET';
    if (url.origin === apiBase && owner) {
      if (
        method === 'GET' &&
        url.pathname === '/api/tasks' &&
        url.searchParams.get('projectId') === project.slug
      )
        return readTasks(owner);

      const body = init?.body == null ? null : JSON.parse(String(init.body));
      if (method === 'POST' && url.pathname === '/api/tasks')
        return createTask(owner, body);
      const citation = /^\/api\/tasks\/([^/]+)\/references$/.exec(url.pathname);
      if (method === 'POST' && citation?.[1])
        return createReference(citation[1], body);
      if (method === 'PUT' && url.pathname === '/api/projects/billing')
        return updateProject(body);
    }
    throw new Error(`Unexpected Setup request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  _setApiBase('');
});

describe('SetupRecommendationsCard', () => {
  test('nothing is created until Apply, and only what is still on', async () => {
    mount();
    const explore = await screen.findByRole('checkbox', {
      name: /New Task: Explore and propose next steps/,
    });
    const brief = screen.getByRole('checkbox', { name: /Brief/ });
    expect(explore).toHaveProperty('checked', true);
    expect(brief).toHaveProperty('checked', true);
    expect(createTask).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();

    fireEvent.click(brief);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.queryByText('Setup recommendations')).toBeNull(),
    );
    expect(createTask.mock.calls).toEqual([
      [
        'account-1',
        expect.objectContaining({
          projectId: 'billing',
          title: 'Explore and propose next steps',
        }),
      ],
    ]);
    expect(updateProject).not.toHaveBeenCalled();
    expect(localStorage.getItem('station.setup-recommendations.done.p-1')).toBe(
      'applied',
    );
  });

  test('a Project continued from a chat gets a Task citing that answer', async () => {
    offerContinuation('Continued from the chat “Revenue”');
    mount({ hasRepository: false, description: 'Continued from the chat' });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
    expect(createReference.mock.calls).toEqual([
      [
        'task-1',
        {
          kind: 'turn',
          sessionId: 'session-1',
          turnId: 'turn-1',
          sourceSurface: 'chat',
        },
      ],
    ]);
  });

  test('after the Task list refetches, retry cites the same Task and adds only unfinished recommendations', async () => {
    const citation = deferred<Response>();
    createReference.mockImplementationOnce(() => citation.promise);
    offerContinuation('brief');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    try {
      await waitFor(() => {
        expect(readTasks.mock.calls.length).toBeGreaterThan(1);
        expect(createReference).toHaveBeenCalledTimes(1);
      });
    } finally {
      await act(async () =>
        citation.resolve(
          Response.json(
            { success: false, error: 'Station is busy' },
            { status: 400 },
          ),
        ),
      );
    }

    await screen.findByText(/Setup didn't finish/);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(updateProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        localStorage.getItem('station.setup-recommendations.done.p-1'),
      ).toBe('applied'),
    );

    expect(createTask.mock.calls.map(([, input]) => input.title)).toEqual([
      'Continue: Revenue',
      'Explore and propose next steps',
    ]);
    expect(updateProject).toHaveBeenCalledTimes(1);
    expect(createReference.mock.calls.map(([taskId]) => taskId)).toEqual([
      'task-1',
      'task-1',
    ]);
  });

  test('changing Station accounts stops later writes and preserves the original continuation', async () => {
    const held = deferred<void>();
    const send = createTask.getMockImplementation()!;
    createTask.mockImplementationOnce(async (owner, body) => {
      const response = await send(owner, body);
      await held.promise;
      return response;
    });
    offerContinuation('brief');
    const view = mount({ description: 'set' });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    try {
      await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
      account = 'account-2';
      view.refreshScope();
      expect(await screen.findByRole('button', { name: 'Apply' })).toBeTruthy();
    } finally {
      await act(async () => held.resolve());
    }

    expect(createTask.mock.calls.map(([owner]) => owner)).toEqual([
      'account-1',
    ]);
    expect(createReference).not.toHaveBeenCalled();
    expect(
      localStorage.getItem('station.setup-recommendations.done.p-1'),
    ).toBeNull();
    expect(sessionStorage.length).toBe(1);
    expect(screen.queryByText(/Setup didn't finish/)).toBeNull();
    expect(screen.queryByText('New Task: Continue: Revenue')).toBeNull();
  });

  test('hidden when the preview is off, the Project has Tasks, or it was dismissed', async () => {
    flags.clear();
    const { unmount } = mount();
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    unmount();

    flags.add('continue-in-project');
    tasks[account] = [{ id: 'existing' }];
    const second = mount();
    await waitFor(() => expect(readTasks).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    second.unmount();

    tasks = {};
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    expect(createTask).not.toHaveBeenCalled();
  });
});
