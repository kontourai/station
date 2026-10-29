/** @vitest-environment jsdom */
import type { TaskRecord } from '@kontourai/station-contracts';
import {
  countThreads,
  parseTaskReviewCreateThreadRequest,
  TASK_REVIEW_LIMITS,
} from '@kontourai/station-contracts/task-review';
import type { Walkthrough } from '@kontourai/station-contracts/walkthrough';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  NavigationProvider,
  navigationStore,
} from '../../../../contexts/NavigationContext';
import { TaskReviewTab } from '../TaskReviewTab';
import {
  capture,
  captureArtifact,
  plan,
  text,
  thread,
} from './review-fixtures';

vi.mock('../../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://review.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://review.test',
    authorityKey: 'review-test-person',
    isCurrent: () => true,
  }),
}));

const task: TaskRecord = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Review test',
  description: '',
  priority: 'normal',
  createdBy: 'person-1',
  status: 'in_progress',
  sessionId: 'lead',
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  sessionStorage.clear();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClientCredentialResolver(undefined);
});

function clip(id: string, title: string): Walkthrough {
  return {
    schema: 'station.walkthrough/v1',
    id,
    title,
    createdAt: '2026-10-25T00:00:00Z',
    source: {
      adapter: 'browser-screencast',
      adapterVersion: '1',
      durationMs: 12500,
      commit: 'a'.repeat(40),
      recording: {
        file: 'recording.webm',
        mediaType: 'video/webm',
        byteLength: 4,
        digest: `sha256:${'b'.repeat(64)}`,
      },
    },
    capture: { platform: 'web' },
    coverage: {
      transcript: 'absent',
      frames: 'absent',
      marks: 'absent',
      elements: 'absent',
      route: 'absent',
      console: 'absent',
      network: 'absent',
    },
    events: [],
  };
}

function setup(
  replied = false,
  sessionUrls = ['https://example.test/preview'],
  clips?: Record<string, Walkthrough[]>,
) {
  _setApiBase('https://review.test');
  if (clips) {
    const requestAuthority = {
      apiBase: 'https://review.test',
      authorityKey: 'review-test-person',
      isCurrent: () => true,
    };
    setClientCredentialResolver(() => ({
      origin: requestAuthority.apiBase,
      requestAuthority,
    }));
  }
  navigationStore.navigate('/projects/project-1/tasks/task-1', {
    taskView: 'review',
    reviewKind: null,
    reviewItem: null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const entries = [
    thread(
      'one',
      1,
      replied ? ['comment', 'sent', 'agent-reply'] : ['comment'],
    ),
  ];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const reads: string[] = [];
  let sendCode: string | undefined;
  let actionCode: string | undefined;
  let captureCode: string | undefined;
  let createCode: string | undefined;
  let pickerFails = false;
  let hasCapture = false;
  let outdated = false;
  let loseCreateResponse = false;
  const planCounts = () =>
    countThreads(
      entries
        .filter((entry) => entry.artifact.kind === 'plan')
        .map((entry) =>
          outdated
            ? { ...entry, state: 'outdated' as const, outdated: true as const }
            : entry,
        ),
    );
  const json = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (path.endsWith('/send')) {
          if (sendCode)
            return new Response(
              JSON.stringify({
                success: false,
                code: sendCode,
                error: 'Internal detail that should not be shown',
              }),
              { status: 409 },
            );
          return json({
            deliveryKey: `delivery-${writes.length}`,
            status: 'queued',
            threads: entries,
          });
        }
        if (path.endsWith('/captures')) {
          if (captureCode)
            return new Response(
              JSON.stringify({
                success: false,
                code: captureCode,
                error: 'Refused at the review boundary.',
              }),
              { status: 409 },
            );
          hasCapture = true;
          return json({ capture });
        }
        if (path.endsWith('/threads')) {
          if (createCode)
            return new Response(
              JSON.stringify({
                success: false,
                code: createCode,
                error: 'Thread creation refused',
              }),
              { status: 409 },
            );
          const parsed = parseTaskReviewCreateThreadRequest(body);
          if (!parsed) throw new Error('Invalid review create request');
          const prior = entries.find(
            (entry) => entry.operationId === parsed.operationId,
          );
          if (prior) return json({ thread: prior });
          const created = {
            ...thread('two', 2),
            artifact: parsed.artifact,
            anchor: parsed.anchor,
            quote: parsed.quote,
            operationId: parsed.operationId,
            events: [
              { ...entries[0]!.events[0]!, body: parsed.body, threadId: 'two' },
            ],
          };
          entries.push(created);
          if (loseCreateResponse) {
            loseCreateResponse = false;
            return new Response('Lost response after commit', { status: 503 });
          }
          return json({ thread: created });
        }
        const target = entries.find((entry) =>
          path.includes(`/threads/${entry.threadId}/`),
        );
        if (target) {
          if (actionCode)
            return new Response(
              JSON.stringify({
                success: false,
                code: actionCode,
                error: 'Refused at the review boundary.',
              }),
              { status: 409 },
            );
          return json({ thread: target });
        }
        throw new Error(`Unexpected Review mutation ${path}`);
      }
      reads.push(path);
      if (path === '/api/feature-previews')
        return json(clips ? [{ id: 'walkthroughs', enabled: true }] : []);
      const clipPath = path.match(
        /^\/api\/tasks\/([^/]+)\/review\/walkthroughs(?:\/([^/]+)\/video)?$/,
      );
      if (clipPath && clips) {
        const available = clips[decodeURIComponent(clipPath[1]!)] ?? [];
        if (!clipPath[2]) {
          const cursor = url.searchParams.get('cursor');
          const after = cursor
            ? available.findIndex((item) => item.id === cursor) + 1
            : 0;
          const items = available.slice(after, after + 5);
          return json({
            items,
            ...(after + items.length < available.length
              ? { nextCursor: items.at(-1)?.id }
              : {}),
          });
        }
        if (available.some((item) => item.id === clipPath[2]))
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { 'Content-Type': 'video/webm' },
          });
        return new Response(
          JSON.stringify({ success: false, error: 'Not found' }),
          { status: 404 },
        );
      }
      if (path.endsWith('/capture-sessions')) {
        if (pickerFails)
          return new Response(
            JSON.stringify({
              success: false,
              code: 'unavailable',
              error: 'Browser sessions unavailable.',
            }),
            { status: 503 },
          );
        return json({
          sessions: sessionUrls.map((url, index) => ({
            browserSessionId: `browser-project-${index + 1}`,
            url,
            viewport: { width: 640, height: 400, deviceScaleFactor: 1 },
          })),
        });
      }
      if (path.endsWith('/content'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (path.endsWith('/items/plan/plan'))
        return json({
          kind: 'plan',
          id: 'plan',
          label: 'Plan',
          status: 'available',
          artifact: plan,
          text,
          counts: planCounts(),
        });
      if (path.includes('/items/capture/'))
        return json({
          kind: 'capture',
          id: capture.captureId,
          label: 'Screen',
          status: 'available',
          artifact: captureArtifact,
          capture,
          counts: { open: 0, outdated: 0, resolved: 0 },
        });
      if (path.includes('/threads/')) {
        const entry = entries.find((entry) =>
          path.endsWith(`/${entry.threadId}`),
        );
        if (!entry) throw new Error(`Unknown thread ${path}`);
        return json({
          thread: {
            ...entry,
            ...(outdated
              ? {
                  state: 'outdated',
                  outdated: true,
                  currentRevision: 'v4',
                  quote: 'Retained quote',
                }
              : {}),
          },
        });
      }
      if (path.endsWith('/review'))
        return json({
          version: 'station.task-review/v1',
          taskId: task.id,
          taskCreatedAt: task.createdAt,
          limits: TASK_REVIEW_LIMITS,
          items: [
            {
              kind: 'plan',
              id: 'plan',
              label: 'Plan',
              status: 'available',
              artifact: plan,
              counts: planCounts(),
            },
            ...(hasCapture
              ? [
                  {
                    kind: 'capture',
                    id: capture.captureId,
                    label: 'Screen',
                    status: 'available',
                    artifact: captureArtifact,
                    capture,
                    counts: { open: 0, outdated: 0, resolved: 0 },
                  },
                ]
              : []),
          ],
          authors: [
            {
              author: { kind: 'person', principalId: 'person-brian' },
              name: 'Brian',
            },
            {
              author: { kind: 'session', sessionId: 'lead' },
              name: 'Claude Code',
              startedBy: { name: 'Brian' },
            },
          ],
          threads: [
            ...entries.map(({ events, ...entry }) => ({
              ...entry,
              ...(outdated
                ? {
                    state: 'outdated',
                    outdated: true,
                    currentRevision: 'v4',
                    quote: 'Retained quote',
                  }
                : {}),
              status: 'available',
              eventCount: events.length,
              openingEvent: events.find((event) => event.kind === 'comment'),
              lastDeliveryEvent: [...events]
                .reverse()
                .find((event) =>
                  ['sent', 'send-failed', 'agent-reply'].includes(event.kind),
                ),
              lastEvent: events.at(-1),
            })),
            {
              status: 'unavailable',
              state: 'unavailable',
              threadId: 'bad',
              artifact: plan,
              ordinal: 9,
              eventCount: 3,
            },
          ],
          counts: planCounts(),
        });
      throw new Error(`Unexpected Review read ${path}`);
    }),
  );
  const view = render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <TaskReviewTab task={task} visible />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    reads,
    writes,
    client,
    loseNextCreateResponse: () => {
      loseCreateResponse = true;
    },
    setCreateCode: (value: string) => {
      createCode = value;
    },
    setActionCode: (value: string) => {
      actionCode = value;
    },
    setCaptureCode: (value: string) => {
      captureCode = value;
    },
    failPicker: () => {
      pickerFails = true;
    },
    setSendCode: (value?: string) => {
      sendCode = value;
    },
    setOutdated: () => {
      outdated = true;
    },
  };
}

test('renders summary identities and delivery previews, expands history on demand, and keeps server counts and filters consistent', async () => {
  const fixture = setup(true);
  await screen.findByRole('button', { name: 'Expand thread 1' });
  await screen.findByRole('article', { name: 'Plan content' });
  expect(fixture.reads.some((path) => path.includes('/threads/'))).toBe(false);
  const summary = screen.getByRole('article', { name: 'Thread 1' });
  await within(summary).findByText('Claude Code');
  expect(within(summary).getByText('Brian')).toBeTruthy();
  expect(within(summary).getByText('CC')).toBeTruthy();
  expect(within(summary).getByText("Brian's agent")).toBeTruthy();
  expect(within(summary).getByText('Replied')).toBeTruthy();
  expect(
    within(summary).getByText(
      'Keeps every exact tie, drops float error. Added a property test.',
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
  expect(
    screen
      .getByRole('button', { name: 'Resolved' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.queryByRole('article', { name: 'Thread 1' })).toBeNull();
  expect(screen.getByText('Thread #9 is unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand thread 1' }));
  await screen.findByRole('button', { name: 'Write reply to thread 1' });
  expect(
    screen.getByRole('button', { name: 'Open 1' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(within(summary).getByText('#1')).toBeTruthy();
  expect(fixture.reads.filter((path) => path.includes('/threads/'))).toEqual([
    '/api/tasks/task-1/review/threads/one',
  ]);
  fireEvent.click(screen.getByRole('button', { name: /^Outdated/ }));
  expect(
    screen
      .getAllByRole('status')
      .some((node) => node.textContent === 'Thread #9 is unavailable.'),
  ).toBe(true);
  fixture.setOutdated();
  await act(async () => {
    await fixture.client.invalidateQueries({
      queryKey: ['task-review', task.id],
    });
  });
  const outdatedCard = await screen.findByRole('article', { name: 'Thread 1' });
  expect(
    screen
      .getByRole('button', { name: 'Outdated 1' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.queryByRole('button', { name: 'Open 1' })).toBeNull();
  expect(within(outdatedCard).getByText('Retained quote')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
    'disabled',
    true,
  );
});

test('keeps a saved reply behind expansion until full thread detail is loaded', async () => {
  const fixture = setup();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Expand thread 1' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Write reply to thread 1' }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Reply to thread 1' }), {
    target: { value: 'A saved reply that still needs context.' },
  });
  fixture.unmount();
  const remounted = setup();
  const expand = await screen.findByRole('button', { name: 'Expand thread 1' });
  expect(
    screen.queryByRole('textbox', { name: 'Reply to thread 1' }),
  ).toBeNull();
  expect(remounted.reads.some((path) => path.includes('/threads/'))).toBe(
    false,
  );
  fireEvent.click(expand);
  expect(
    await screen.findByRole('textbox', { name: 'Reply to thread 1' }),
  ).toHaveProperty('value', 'A saved reply that still needs context.');
  expect(remounted.reads.filter((path) => path.includes('/threads/'))).toEqual([
    '/api/tasks/task-1/review/threads/one',
  ]);
});

test('retries a committed comment with the same key, then uses fresh send keys with compact inline refusals', async () => {
  const fixture = setup();
  fixture.loseNextCreateResponse();
  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
  const article = await screen.findByRole('article', { name: 'Plan content' });
  const node = within(article).getByText('half-even rounding').firstChild!;
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(article);
  const selection = screen.queryByRole('toolbar', {
    name: 'Selection actions',
  });
  if (selection)
    fireEvent.click(
      within(selection).getByRole('button', { name: 'Comment C' }),
    );
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'New comment' }),
    { target: { value: 'Keep this rule.' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(fixture.writes).toHaveLength(1));
  expect(fixture.writes[0]).toMatchObject({
    path: '/api/tasks/task-1/review/threads',
    body: {
      artifact: plan,
      body: 'Keep this rule.',
      anchor: { kind: 'text-quote', exact: 'half-even rounding' },
    },
  });
  await screen.findByText('Review action failed. Try again.');
  expect(screen.getByRole('textbox', { name: 'New comment' })).toHaveProperty(
    'value',
    'Keep this rule.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(fixture.writes).toHaveLength(2));
  expect(fixture.writes[1]!.body.operationId).toBe(
    fixture.writes[0]!.body.operationId,
  );
  await waitFor(() =>
    expect(
      fixture.client.getQueryData(['task-review', task.id]),
      JSON.stringify(fixture.reads),
    ).toMatchObject({
      threads: [
        expect.objectContaining({ threadId: 'one' }),
        expect.objectContaining({ threadId: 'two' }),
        expect.objectContaining({ threadId: 'bad' }),
      ],
    }),
  );
  await screen.findByRole('button', { name: 'Write reply to thread 2' });
  expect(
    screen.getByRole('button', { name: 'Open 2' }).getAttribute('aria-pressed'),
  ).toBe('true');
  fixture.setSendCode('no-live-agent');
  fireEvent.click(screen.getByRole('button', { name: 'Send 2' }));
  await screen.findByText('Start the lead agent before sending.');
  expect(
    screen.queryByText('Internal detail that should not be shown'),
  ).toBeNull();
  fixture.setSendCode();
  fireEvent.click(screen.getByRole('button', { name: 'Send 2' }));
  await waitFor(() =>
    expect(
      fixture.writes.filter((write) => write.path.endsWith('/send')),
    ).toHaveLength(2),
  );
  expect(screen.queryByText('Sent to the lead agent.')).toBeNull();
  const sends = fixture.writes.filter((write) => write.path.endsWith('/send'));
  expect(sends).toHaveLength(2);
  expect(sends[0]!.body.operationId).not.toBe(sends[1]!.body.operationId);
  expect(sends[1]!.body).toMatchObject({
    threadIds: ['one', 'two'],
    mode: 'send',
  });
});

test('lists Task clips without reading video, then releases the opened clip on close and unmount', async () => {
  const createUrl = vi.fn(() => 'blob:review-clip');
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  const fixture = setup(false, undefined, {
    'task-1': [clip('clip-a', 'Checkout tour')],
  });
  const entry = await screen.findByRole('button', {
    name: /Checkout tour.*aaaaaaa.*0:13/,
  });
  expect(fixture.reads.filter((path) => path.endsWith('/video'))).toEqual([]);
  fireEvent.click(entry);
  const dialog = await screen.findByRole('dialog', { name: 'Checkout tour' });
  await waitFor(() =>
    expect(dialog.querySelector('video')?.getAttribute('src')).toBe(
      'blob:review-clip',
    ),
  );
  expect(fixture.reads.filter((path) => path.endsWith('/video'))).toEqual([
    '/api/tasks/task-1/review/walkthroughs/clip-a/video',
  ]);
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Close walkthrough clip' }),
  );
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  expect(revokeUrl).toHaveBeenCalledWith('blob:review-clip');
  fireEvent.click(entry);
  await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(2));
  expect(fixture.reads.filter((path) => path.endsWith('/video'))).toHaveLength(
    2,
  );
  fixture.unmount();
  expect(revokeUrl).toHaveBeenCalledTimes(2);
});

test('switching Tasks discards the first Task’s clip and closes its player', async () => {
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:first-task');
      static revokeObjectURL = revokeUrl;
    },
  );
  const fixture = setup(false, undefined, {
    'task-1': [clip('clip-a', 'First Task clip')],
    'task-2': [clip('clip-b', 'Second Task clip')],
  });
  fireEvent.click(
    await screen.findByRole('button', { name: /First Task clip/ }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole('dialog', { name: 'First Task clip' })
        .querySelector('video'),
    ).toBeTruthy(),
  );
  fixture.rerender(
    <QueryClientProvider client={fixture.client}>
      <NavigationProvider>
        <TaskReviewTab task={{ ...task, id: 'task-2' }} visible />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: /Second Task clip/ });
  expect(screen.queryByRole('button', { name: /First Task clip/ })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'First Task clip' })).toBeNull();
  expect(revokeUrl).toHaveBeenCalledWith('blob:first-task');
  expect(fixture.reads).toContain('/api/tasks/task-2/review/walkthroughs');
  expect(fixture.reads.filter((path) => path.endsWith('/video'))).toEqual([
    '/api/tasks/task-1/review/walkthroughs/clip-a/video',
  ]);
});

test('loads further clip pages only on request and does not fetch their video', async () => {
  const entries = Array.from({ length: 7 }, (_, index) =>
    clip(`clip-${index}`, `Tour ${index}`),
  );
  const fixture = setup(false, undefined, { 'task-1': entries });
  await screen.findByRole('button', { name: /Tour 0/ });
  expect(screen.queryByRole('button', { name: /Tour 6/ })).toBeNull();
  expect(
    fixture.reads.filter((path) => path.endsWith('/walkthroughs')),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Show more clips' }));
  await screen.findByRole('button', { name: /Tour 6/ });
  expect(screen.queryByRole('button', { name: 'Show more clips' })).toBeNull();
  expect(
    fixture.reads.filter((path) => path.endsWith('/walkthroughs')),
  ).toHaveLength(2);
  expect(fixture.reads.filter((path) => path.endsWith('/video'))).toHaveLength(
    0,
  );
});

test('captures from the Project session picker, loads authenticated content and posts a keyboard region pin', async () => {
  const createUrl = vi.fn(() => 'blob:review-screen');
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  const fixture = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
  await screen.findByRole('option', { name: 'example.test · /preview' });
  fireEvent.click(screen.getByRole('button', { name: 'Capture Screen' }));
  const pin = await screen.findByRole('button', { name: 'Place region pin' });
  expect(screen.queryByText('Thread #9 is unavailable.')).toBeNull();
  expect(fixture.writes[0]!.body).toMatchObject({
    sourceKind: 'browser',
    sourceSessionId: 'browser-project-1',
  });
  expect(
    fixture.reads.some((path) =>
      path.endsWith(`/captures/${capture.captureId}/content`),
    ),
  ).toBe(true);
  fireEvent.keyDown(pin, { key: 'ArrowRight' });
  fireEvent.click(pin, { detail: 0 });
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'New comment' }),
    { target: { value: 'Align this region.' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await waitFor(() => expect(fixture.writes).toHaveLength(2));
  expect(fixture.writes[1]!.body).toMatchObject({
    artifact: captureArtifact,
    anchor: { kind: 'region', x: 0.5, y: 0.48, w: 0.04, h: 0.04 },
    body: 'Align this region.',
  });
  fixture.unmount();
  expect(revokeUrl).toHaveBeenCalledWith('blob:review-screen');
});

test.each([
  [
    'invalid-transition',
    'resolve',
    'This thread changed. Refresh and try again.',
  ],
  ['message-too-large', 'send', 'Send fewer threads, or use Copy for agent.'],
  ['capture-limit', 'capture', 'This Task has reached its Screen limit.'],
  ['thread-limit', 'create', 'This Task has reached its thread limit.'],
  ['event-limit', 'resolve', 'This thread has reached its reply limit.'],
  ['screenshot-too-large', 'capture', 'This Screen is too large to capture.'],
  [
    'operation-conflict',
    'resolve',
    'This action changed. Refresh and try again.',
  ],
  [
    'capture-unavailable',
    'capture',
    'This Screen is unavailable. Capture it again.',
  ],
])(
  'maps %s to a compact inline state at the mounted action',
  async (code, action, message) => {
    const fixture = setup();
    await screen.findByRole('button', { name: 'Expand thread 1' });
    if (action === 'capture') {
      fixture.setCaptureCode(code);
      fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
      await screen.findByRole('option', { name: 'example.test · /preview' });
      fireEvent.click(screen.getByRole('button', { name: 'Capture Screen' }));
    } else if (action === 'create') {
      fixture.setCreateCode(code);
      const article = await screen.findByRole('article', {
        name: 'Plan content',
      });
      fireEvent.click(within(article).getByText('half-even rounding'));
      fireEvent.keyDown(article, { key: 'c' });
      fireEvent.change(
        await screen.findByRole('textbox', { name: 'New comment' }),
        { target: { value: 'A new thread' } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
      await waitFor(() => expect(fixture.writes).toHaveLength(1));
      expect(fixture.writes[0]!.path).toBe('/api/tasks/task-1/review/threads');
    } else if (action === 'send') {
      fixture.setSendCode(code);
      fireEvent.click(screen.getByRole('button', { name: 'Send 1' }));
    } else {
      fixture.setActionCode(code);
      fireEvent.click(screen.getByRole('button', { name: 'Expand thread 1' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Resolve thread 1' }),
      );
    }
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.querySelector('.empty--compact')).toBeTruthy();
  },
);

test('shows a compact capture-picker failure and lets the person refresh it', async () => {
  const fixture = setup();
  fixture.failPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Couldn’t load Browser sessions.');
  const reads = fixture.reads.filter((path) =>
    path.endsWith('/capture-sessions'),
  ).length;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
  await waitFor(() =>
    expect(
      fixture.reads.filter((path) => path.endsWith('/capture-sessions')).length,
    ).toBe(reads + 1),
  );
});

test('capture picker survives malformed URLs and distinguishes same-host paths and file names', async () => {
  setup(false, [
    'not a URL',
    'https://example.test/first',
    'https://example.test/second',
    'file:///tmp/review%20screen.html',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
  const picker = await screen.findByRole('combobox', {
    name: 'Browser session',
  });
  await waitFor(() =>
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Unavailable page',
      'example.test · /first',
      'example.test · /second',
      'review screen.html',
    ]),
  );
});
