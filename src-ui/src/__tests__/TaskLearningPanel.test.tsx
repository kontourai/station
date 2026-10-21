/**
 * @vitest-environment jsdom
 */

/**
 * #4003 layer 4: the Task workspace's lesson review. The real panel and the
 * real SDK hooks, served by the real learning routes
 * (`createTaskLearningRoutes`) over the real Task memory store (migrations
 * 017 and 018 in an in-memory SQLite database) and a real
 * `KnowledgeStoreProvider` writing Kit records in a temporary directory.
 * The person's room authority is granted by a stand-in; that authority, the
 * agent refusal and search are proved in `runtime-routes-task-learning.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TASK_MEMORY_MIGRATION } from '../../../src-server/domain/migrations/017-task-memory';
import { TASK_LEARNING_DISMISSALS_MIGRATION } from '../../../src-server/domain/migrations/018-task-learning-dismissals';
import { KnowledgeStoreProvider } from '../../../src-server/knowledge-store/knowledge-store-provider';
import { createTaskLearningRoutes } from '../../../src-server/routes/orchestration/task-learning';
import { createSqliteTaskMemoryStore } from '../../../src-server/services/orchestration/task-memory-store';
import { TaskLearningPanel } from '../views/task-workspace/TaskLearningPanel';

const setProject = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setProject,
    updateParams: vi.fn(),
    navigate: vi.fn(),
  }),
}));

const BASE = 'http://station.test';
const TASK: TaskRecord = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Ship the queue',
  description: '',
  priority: 'normal',
  status: 'done',
  createdBy: 'human:local:operator',
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  workItemRef: 'github:acme/widgets#7',
};
const INCARNATION = { taskId: TASK.id, taskCreatedAt: TASK.createdAt };

class MemoryRootPersistence {
  roots: KnowledgeStoreRoot[] = [];
  listKnowledgeStoreRoots() {
    return this.roots.slice();
  }
  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot) {
    this.roots.push(root);
  }
  removeKnowledgeStoreRoot(id: string) {
    this.roots = this.roots.filter((r) => r.id !== id);
  }
}

let db: DatabaseSync;
let directory: string;
let knowledge: KnowledgeStoreProvider;
let requests: Array<{ method: string; path: string; body?: unknown }>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(TASK_MEMORY_MIGRATION);
  db.exec(TASK_LEARNING_DISMISSALS_MIGRATION);
  const memory = createSqliteTaskMemoryStore(db);
  const write = {
    projectId: TASK.projectId,
    ...INCARNATION,
    author: { kind: 'session', sessionId: 'session-lead' } as const,
  };
  memory.writeRecord({
    ...write,
    write: {
      kind: 'decision',
      key: 'storage-engine',
      text: 'Use SQLite for the queue.',
    },
  });
  memory.writeRecord({
    ...write,
    write: {
      kind: 'dead_end',
      key: 'naive-retry',
      text: 'Retrying without backoff floods the provider.',
    },
  });
  directory = mkdtempSync(join(tmpdir(), 'task-learning-panel-'));
  knowledge = new KnowledgeStoreProvider(new MemoryRootPersistence());
  const app = new Hono().route(
    '/api/tasks',
    createTaskLearningRoutes({
      store: knowledge,
      access: async () => ({
        kind: 'granted',
        memory,
        task: TASK,
        projectId: TASK.projectId,
        projectSlug: 'widgets',
        principalId: 'human:local:operator',
        isCurrent: () => true,
      }),
    }),
  );
  requests = [];
  _setApiBase(BASE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return app.request(url.pathname, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(init?.body ? { body: init.body } : {}),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setProject.mockReset();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

const createStore = () =>
  knowledge.createRoot({
    scope: { kind: 'project', projectSlug: 'widgets' },
    adapterId: 'kit-default-store',
    storeRoot: directory,
    displayName: 'Widgets knowledge',
  });

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskLearningPanel taskId="task-1" />
    </QueryClientProvider>,
  );
}

describe('TaskLearningPanel', () => {
  test('a Project with no store says so plainly and links to the Project', async () => {
    renderPanel();
    expect(
      await screen.findByText(/This Project has no knowledge store/),
    ).toBeTruthy();
    const candidates = screen.getAllByTestId('task-learning-candidate');
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates)
      expect(
        (
          within(candidate).getByRole('button', {
            name: 'Promote…',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open the Project' }));
    expect(setProject).toHaveBeenCalledWith('widgets');
  });

  test('Promote writes the edited text into the store with provenance, then reads as promoted', async () => {
    const root = await createStore();
    renderPanel();
    const [decision] = await screen.findAllByTestId('task-learning-candidate');
    expect(
      within(decision!).getByText('Use SQLite for the queue.'),
    ).toBeTruthy();
    fireEvent.click(
      within(decision!).getByRole('button', { name: 'Promote…' }),
    );
    const title = within(decision!).getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Decision: storage engine');
    fireEvent.change(
      within(decision!).getByLabelText('What the Project should keep'),
      { target: { value: 'The queue stores in SQLite (WAL).' } },
    );
    fireEvent.click(within(decision!).getByRole('button', { name: 'Promote' }));

    await waitFor(() =>
      expect(screen.getAllByTestId('task-learning-candidate')).toHaveLength(1),
    );
    expect(screen.getByText('Reviewed (1)')).toBeTruthy();
    expect(screen.getByText('Promoted to Widgets knowledge')).toBeTruthy();

    const records = await (await knowledge.adapterFor(root.id)).listByType(
      'raw',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      title: 'Decision: storage engine',
      body: 'The queue stores in SQLite (WAL).',
      provenance: {
        agent: 'station-task-learning',
        session_id: 'session-lead',
      },
    });
    expect(records[0]?.provenance.note).toContain(
      'work item: github:acme/widgets#7',
    );
    expect(
      requests.find((r) => r.path.endsWith('/learning/promote'))?.body,
    ).toEqual({
      kind: 'decision',
      key: 'storage-engine',
      version: 1,
      rootId: root.id,
      title: 'Decision: storage engine',
      text: 'The queue stores in SQLite (WAL).',
    });
  });

  test('Dismiss persists and the candidate is no longer offered', async () => {
    await createStore();
    renderPanel();
    const candidates = await screen.findAllByTestId('task-learning-candidate');
    fireEvent.click(
      within(candidates[1]!).getByRole('button', { name: 'Dismiss' }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('task-learning-candidate')).toHaveLength(1),
    );
    expect(screen.getByText('Dismissed')).toBeTruthy();
    expect(
      createSqliteTaskMemoryStore(db).listLearningDismissals(INCARNATION),
    ).toMatchObject([{ kind: 'dead_end', key: 'naive-retry', version: 1 }]);
  });
});
