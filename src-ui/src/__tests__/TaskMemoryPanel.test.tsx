/**
 * @vitest-environment jsdom
 */

/**
 * #4003 Task memory panel: the real panel and the real SDK hooks, served by
 * the real Task memory store (`createSqliteTaskMemoryStore` over migration
 * 020 in an in-memory SQLite database) behind a stand-in for the person's
 * `/api/tasks/:taskId/room/memory` routes that answers with the routes' own
 * outcome mapping (`task-memory-http.ts`). The routes
 * and their authority are proved in `runtime-routes-task-memory-engine.test.ts`;
 * this proves what a person sees, the edit and its conflict path, and that
 * Answer writes the answer.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  TASK_MEMORY_LIMITS,
  TASK_MEMORY_VERSION,
} from '@kontourai/station-contracts/task-memory';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TASK_MEMORY_MIGRATION } from '../../../src-server/domain/migrations/020-task-memory';
import {
  taskRecordResponse,
  taskSummaryResponse,
} from '../../../src-server/routes/orchestration/task-memory-http';
import { createSqliteTaskMemoryStore } from '../../../src-server/services/orchestration/task-memory-store';
import { navigationStore } from '../contexts/navigation-store';
import { TaskMemoryPanel } from '../views/task-workspace/TaskMemoryPanel';

const updateParams = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ updateParams, navigate: vi.fn() }),
}));

const TASK = { taskId: 'task-1', taskCreatedAt: '2026-10-21T00:00:00.000Z' };
const BASE = 'http://station.test';
const PERSON = { kind: 'person', principalId: 'human:local:operator' } as const;
const LEAD = { kind: 'session', sessionId: 'session-lead-0123456789' } as const;

let db: DatabaseSync;
let store: ReturnType<typeof createSqliteTaskMemoryStore>;
let requests: Array<{ method: string; path: string; body?: unknown }>;

const write = (author: typeof PERSON | typeof LEAD) => ({
  projectId: 'project-1',
  ...TASK,
  author,
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(TASK_MEMORY_MIGRATION);
  store = createSqliteTaskMemoryStore(db);
  requests = [];
  _setApiBase(BASE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path: url.pathname, body });
      const envelope = (
        outcome: ReturnType<typeof taskSummaryResponse>,
        key: 'summary' | 'record',
      ) =>
        outcome.status === 200
          ? Response.json({ success: true, data: outcome.body[key] })
          : Response.json(outcome.body, { status: outcome.status });
      if (url.pathname === '/api/tasks/task-1/room/memory/summary') {
        const result = store.updateSummary({ ...write(PERSON), ...body });
        return envelope(
          taskSummaryResponse(
            result.kind === 'updated'
              ? { ...result, taskId: TASK.taskId }
              : (result as never),
          ),
          'summary',
        );
      }
      if (url.pathname === '/api/tasks/task-1/room/memory/records') {
        const result = store.writeRecord({ ...write(PERSON), write: body });
        return envelope(
          taskRecordResponse(
            result.kind === 'recorded'
              ? { ...result, taskId: TASK.taskId }
              : (result as never),
          ),
          'record',
        );
      }
      expect(url.pathname).toBe('/api/tasks/task-1/room/memory');
      const summary = store.readSummary(TASK);
      return Response.json({
        success: true,
        data: {
          version: TASK_MEMORY_VERSION,
          taskId: TASK.taskId,
          ...(summary ? { summary } : {}),
          records: store.listRecords(TASK),
          limits: TASK_MEMORY_LIMITS,
        },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  updateParams.mockReset();
  db.close();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskMemoryPanel taskId="task-1" />
    </QueryClientProvider>,
  );
}

const section = (panel: HTMLElement, name: string) =>
  within(panel).getByRole('region', { name: new RegExp(`^${name}`) });

describe('Task memory panel', () => {
  test('shows the summary with its revision and author, and records by kind with their tiers', async () => {
    store.updateSummary({
      ...write(LEAD),
      text: 'Now: parser fixed.\nNext: tests.',
      baseRevision: 0,
    });
    store.writeRecord({
      ...write(LEAD),
      write: { kind: 'decision', key: 'storage', text: 'Use SQLite.' },
    });
    store.writeRecord({
      ...write(LEAD),
      write: {
        kind: 'decision',
        key: 'narrow',
        text: 'Only the CLI.',
        importance: 'on_topic',
      },
    });
    store.writeRecord({
      ...write(LEAD),
      write: { kind: 'question', key: 'scope', text: 'Ship the CLI too?' },
    });
    store.writeRecord({
      ...write(LEAD),
      write: { kind: 'dead_end', key: 'regex', text: 'A regex cannot nest.' },
    });
    store.writeRecord({
      ...write(LEAD),
      write: { kind: 'dead_end', key: 'old', text: 'Old idea.' },
    });
    store.writeRecord({
      ...write(PERSON),
      write: {
        kind: 'dead_end',
        key: 'old',
        action: 'retire',
        reason: 'No longer true.',
      },
    });
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    await within(panel).findByText(/Now: parser fixed\./);
    expect(within(panel).getByTestId('task-summary-meta').textContent).toMatch(
      /^Revision 1 · Session session-lead… · /,
    );
    const decisions = section(panel, 'Decisions');
    expect(
      within(decisions)
        .getAllByTestId('task-memory-record')
        .map((row) => [
          row.querySelector('.task-memory__text')?.textContent,
          row.querySelector('.task-memory__tier')?.textContent,
        ]),
    ).toEqual([
      // Newest first.
      ['Only the CLI.', 'On topic'],
      ['Use SQLite.', 'Standing'],
    ]);
    expect(
      within(section(panel, 'Open questions')).getByText('Ship the CLI too?'),
    ).toBeTruthy();
    const deadEnds = section(panel, 'Dead ends');
    expect(within(deadEnds).getByText('A regex cannot nest.')).toBeTruthy();
    // Retired records leave the live lists and stay in the history.
    expect(within(deadEnds).queryByText('Old idea.')).toBeNull();
    const history = within(panel).getByText('Answered and retired (1)');
    expect(
      within(history.closest('details')!).getByText('Retired: No longer true.'),
    ).toBeTruthy();
  });

  test('a person edits the summary; the store keeps both revisions', async () => {
    store.updateSummary({
      ...write(LEAD),
      text: 'Agent view.',
      baseRevision: 0,
    });
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const box = within(panel).getByRole('textbox');
    expect((box as HTMLTextAreaElement).value).toBe('Agent view.');
    fireEvent.change(box, { target: { value: 'Person view.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await within(panel).findByText('Person view.');
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      text: 'Person view.',
      baseRevision: 1,
    });
    expect(store.readSummary(TASK)).toMatchObject({
      revision: 2,
      text: 'Person view.',
      author: PERSON,
    });
    expect(store.listSummaryRevisions({ ...TASK, limit: 5 }).total).toBe(2);
  });

  test('a stale edit shows the current summary and saves over the revision shown', async () => {
    store.updateSummary({
      ...write(LEAD),
      text: 'Agent view.',
      baseRevision: 0,
    });
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    // An agent rewrites it while the person is editing.
    store.updateSummary({
      ...write(LEAD),
      text: 'Agent, newer.',
      baseRevision: 1,
    });
    fireEvent.change(within(panel).getByRole('textbox'), {
      target: { value: 'Person view.' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain(
      'Someone saved revision 2 while you were editing.',
    );
    expect(within(alert).getByText('Agent, newer.')).toBeTruthy();
    // Nothing was written by the refused save; the draft is kept.
    expect(store.readSummary(TASK)?.revision).toBe(2);
    expect(
      (within(panel).getByRole('textbox') as HTMLTextAreaElement).value,
    ).toBe('Person view.');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Save over revision 2' }),
    );
    await waitFor(() =>
      expect(store.readSummary(TASK)).toMatchObject({
        revision: 3,
        text: 'Person view.',
      }),
    );
    expect(
      requests.filter((r) => r.method === 'PUT').map((r) => r.body),
    ).toEqual([
      { text: 'Person view.', baseRevision: 1 },
      { text: 'Person view.', baseRevision: 2 },
    ]);
  });

  test('an over-cap summary is refused in place, before anything is sent', async () => {
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Write summary' }),
    );
    fireEvent.change(within(panel).getByRole('textbox'), {
      target: { value: 'x'.repeat(4001) },
    });
    expect(
      within(panel).getByText(
        /The summary is 4001 characters; the limit is 4000/,
      ),
    ).toBeTruthy();
    expect(
      (within(panel).getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  test('Answer writes the answer, and the question leaves the open list', async () => {
    store.writeRecord({
      ...write(LEAD),
      write: { kind: 'question', key: 'scope', text: 'Ship the CLI too?' },
    });
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    const open = await within(panel).findByRole('region', {
      name: /^Open questions/,
    });
    fireEvent.click(
      await within(open).findByRole('button', { name: 'Answer' }),
    );
    fireEvent.change(within(open).getByRole('textbox'), {
      target: { value: 'No.' },
    });
    fireEvent.click(within(open).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(store.listOpenQuestions(TASK)).toEqual([]));
    expect(store.listRecords(TASK)).toMatchObject([
      { key: 'scope', state: 'answered', answer: 'No.', author: PERSON },
    ]);
    await within(panel).findByText('Nothing is waiting on a person');
    expect(within(panel).getByText('Answer: No.')).toBeTruthy();
  });

  test('leaving with an unsaved summary edit asks first, and an untouched draft does not', async () => {
    store.updateSummary({
      ...write(LEAD),
      text: 'Agent view.',
      baseRevision: 0,
    });
    navigationStore.navigate('/task-memory-origin');
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    // An open editor whose text matches the summary holds nothing to lose.
    act(() => navigationStore.navigate('/task-memory-untouched'));
    expect(window.location.pathname).toBe('/task-memory-untouched');
    expect(
      screen.queryByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeNull();

    fireEvent.change(within(panel).getByRole('textbox'), {
      target: { value: 'Half a thought' },
    });
    act(() => navigationStore.navigate('/task-memory-elsewhere'));
    const dialog = await screen.findByRole('dialog', {
      name: 'Unsaved Changes',
    });
    expect(window.location.pathname).toBe('/task-memory-untouched');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/task-memory-untouched');
    expect(
      (within(panel).getByRole('textbox') as HTMLTextAreaElement).value,
    ).toBe('Half a thought');
  });

  test('a failed read says so with the shared error state and retries', async () => {
    const served = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(async () =>
      Response.json(
        { success: false, error: 'Task memory is not running' },
        { status: 503 },
      ),
    );
    renderPanel();
    const panel = await screen.findByTestId('task-memory-panel');
    await within(panel).findByText('Couldn’t read the Task memory');
    vi.mocked(fetch).mockImplementation(served);
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await within(panel).findByText('No summary yet');
  });
});
