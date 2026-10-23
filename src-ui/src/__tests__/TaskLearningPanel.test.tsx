/**
 * @vitest-environment jsdom
 */

/**
 * #4003 layer 4: the Task workspace's lesson review. The real panel and the
 * real SDK hooks, served by the real learning routes
 * (`createTaskLearningRoutes`) over the real Task memory store (migrations
 * 020 and 021 in an in-memory SQLite database) and a real
 * `KnowledgeStoreProvider` writing Kit records in a temporary directory.
 * The person's room authority is granted by a stand-in; that authority, the
 * agent refusal and search are proved in `runtime-routes-task-learning.test.ts`.
 */
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
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import { TASK_MEMORY_MIGRATION } from '../../../src-server/domain/migrations/020-task-memory';
import { TASK_LEARNING_DISMISSALS_MIGRATION } from '../../../src-server/domain/migrations/021-task-learning-dismissals';
import { TASK_LEARNING_PROMOTIONS_MIGRATION } from '../../../src-server/domain/migrations/022-task-learning-promotions';
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
const makeTempDir = trackTempDirs();
let directory: string;
let knowledge: KnowledgeStoreProvider;
let requests: Array<{ method: string; path: string; body?: unknown }>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(TASK_MEMORY_MIGRATION);
  db.exec(TASK_LEARNING_DISMISSALS_MIGRATION);
  // As EventStore's constructor: the promotion row (migration 022).
  db.exec(TASK_LEARNING_PROMOTIONS_MIGRATION);
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
  directory = makeTempDir('task-learning-panel-');
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

  /** A promotion recorded for `store`'s identity, whose write never ran. */
  const unfinishedPromotion = (store: {
    id: string;
    adapterId: string;
    storeRoot: string;
  }) =>
    createSqliteTaskMemoryStore(db).claimLearningPromotion({
      ...INCARNATION,
      kind: 'decision',
      key: 'storage-engine',
      version: 1,
      projectId: TASK.projectId,
      rootId: store.id,
      adapterId: store.adapterId,
      storeRoot: store.storeRoot,
      principalId: 'human:local:operator',
    });

  test('a pending promotion offers only to finish it, with one wording, and finishing it reads as promoted (review round 5)', async () => {
    const root = await createStore();
    expect(unfinishedPromotion(root).kind).toBe('claimed');
    renderPanel();
    const candidates = await screen.findAllByTestId('task-learning-candidate');
    const pending = candidates.find((item) =>
      item.textContent?.includes('storage-engine'),
    )!;
    expect(within(pending).getByRole('status').textContent).toBe(
      'A promotion into Widgets knowledge is recorded, but its record is not in that store yet. Finish the promotion to write it there.',
    );
    expect(within(pending).queryByRole('button', { name: 'Dismiss' })).toBe(
      null,
    );
    fireEvent.click(
      within(pending).getByRole('button', { name: 'Finish promotion…' }),
    );
    fireEvent.click(
      within(pending).getByRole('button', { name: 'Finish promotion' }),
    );
    await screen.findByText('Promoted to Widgets knowledge');
    expect(screen.getAllByTestId('task-learning-candidate')).toHaveLength(1);
  });

  test('a promotion recorded for a store the Project no longer has is a closed review, never offered, even when its root id was reused (review round 5)', async () => {
    // The store that was promoted into: another directory, same root id as
    // the store the Project has now.
    const current = await createStore();
    expect(
      unfinishedPromotion({
        id: current.id,
        adapterId: current.adapterId,
        storeRoot: `${current.storeRoot}-removed`,
      }).kind,
    ).toBe('claimed');
    renderPanel();
    await screen.findAllByTestId('task-learning-reviewed');
    expect(
      screen
        .getAllByTestId('task-learning-candidate')
        .some((item) => item.textContent?.includes('storage-engine')),
    ).toBe(false);
    const closed = screen
      .getAllByTestId('task-learning-reviewed')
      .find((item) => item.textContent?.includes('storage-engine'))!;
    expect(closed.textContent).toContain(
      'Promotion recorded; its store is no longer one of this Project’s',
    );
    expect(closed.textContent).not.toMatch(/did not finish|was written/);
    expect(within(closed).queryAllByRole('button')).toEqual([]);
  });

  test('the dismiss route refuses a version with a recorded promotion: 409 task_learning_promoted, nothing written (review rounds 4 and 5)', async () => {
    const root = await createStore();
    unfinishedPromotion(root);
    const response = await fetch(
      `${BASE}/api/tasks/task-1/room/memory/learning/dismiss`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'decision',
          key: 'storage-engine',
          version: 1,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'task_learning_promoted',
      error:
        "A promotion of that version is already recorded, so it can't be dismissed. Nothing was written.",
    });
    expect(
      createSqliteTaskMemoryStore(db).listLearningDismissals(INCARNATION),
    ).toEqual([]);
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
