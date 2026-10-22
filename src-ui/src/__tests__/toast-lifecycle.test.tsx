/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NotificationContainer } from '../components/notifications/NotificationContainer';
import { ToastProvider, toastStore } from '../contexts/ToastContext';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatIds: () => [],
}));

// Visibility is browser input. jsdom has no layout; these tests drive the
// same observer notifications the mounted cards receive in a browser.
class VisibleObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0, 0.95, 1];
  takeRecords() {
    return [];
  }
  unobserve() {}
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ],
      this,
    );
  }
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', VisibleObserver);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  toastStore.dismissAll();
  toastStore.clearHistory();
  localStorage.clear();
  toastStore.bindScope('station-a');
});
afterEach(() => {
  cleanup();
  toastStore.dismissAll();
  toastStore.clearHistory();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () =>
  render(
    <ToastProvider stationScope="station-a">
      <NotificationContainer />
    </ToastProvider>,
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

test('overflow waits to become visible before its expiration starts', () => {
  for (const message of ['Waiting', 'Third', 'Second', 'First'])
    toastStore.show(message, undefined, 1000);
  advance(30000);
  mount();
  expect(
    screen.getByRole('button', { name: '1 more notifications · View all' }),
  ).toBeTruthy();
  expect(screen.queryByText('Waiting')).toBeNull();
  advance(1000);
  expect(screen.getByText('Waiting')).toBeTruthy();
  advance(999);
  expect(screen.getByText('Waiting')).toBeTruthy();
  advance(1);
  expect(screen.queryByText('Waiting')).toBeNull();
});

test('hover, focus, open details and a hidden app pause the remaining reading time', () => {
  toastStore.upsert({
    message: 'Read me',
    detail: 'More context',
    duration: 1000,
  });
  mount();
  advance(400);
  const card = screen.getByTestId('toast-card');
  fireEvent.mouseEnter(card);
  advance(5000);
  fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }));
  fireEvent.mouseLeave(card);
  advance(5000);
  const details = screen.getByText('More context').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.blur(screen.getByRole('button', { name: 'Dismiss notification' }), {
    relatedTarget: document.body,
  });
  advance(5000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  details.open = false;
  fireEvent(details, new Event('toggle'));
  advance(5000);
  expect(screen.getByText('Read me')).toBeTruthy();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  fireEvent(document, new Event('visibilitychange'));
  advance(599);
  expect(screen.getByText('Read me')).toBeTruthy();
  advance(1);
  expect(screen.queryByText('Read me')).toBeNull();
});

test('async actions are pending once, survive failure and retry with adequate reading time', async () => {
  let reject: (reason: Error) => void = () => {
    throw new Error('Action was not started');
  };
  const retry = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    )
    .mockResolvedValueOnce(undefined);
  toastStore.upsert({
    message: 'Reconnect',
    duration: 1000,
    actions: [{ label: 'Retry', onClick: retry }],
  });
  mount();
  advance(6000);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const pending = screen.getByRole('button', {
    name: 'Working…',
  }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(retry).toHaveBeenCalledTimes(1);
  advance(30000);
  await act(async () => reject(new Error('secret-provider-token')));
  expect(screen.getByRole('alert').textContent).toBe(
    'Action failed. Try again.',
  );
  expect(screen.queryByText(/secret-provider/)).toBeNull();
  advance(30000);
  expect(screen.getByText('Reconnect')).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })),
  );
  expect(retry).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Reconnect')).toBeNull();
});

test('operation updates and explicit groups replace actions; old completions cannot dismiss a newer revision', async () => {
  let finish: () => void = () => {
    throw new Error('Action was not started');
  };
  const old = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const latest = vi.fn();
  const id = toastStore.upsert({
    id: 'sync',
    message: 'Syncing',
    duration: 0,
    actions: [{ label: 'Old action', onClick: old }],
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Old action' }));
  act(() =>
    toastStore.update(id, {
      message: 'Sync needs retry',
      actions: [{ label: 'New action', onClick: latest }],
    }),
  );
  await act(async () => finish());
  expect(screen.getByText('Sync needs retry')).toBeTruthy();
  expect(screen.queryByText('Old action')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New action' }));
  expect(latest).toHaveBeenCalledOnce();
  const stale = vi.fn();
  act(() => {
    toastStore.upsert({
      dedupeKey: 'reconnect',
      message: 'Offline',
      actions: [{ label: 'Retry stale', onClick: stale }],
    });
    toastStore.upsert({
      dedupeKey: 'reconnect',
      message: 'Offline',
      actions: [{ label: 'Retry current', onClick: latest }],
    });
  });
  expect(screen.getByText('Repeated 2 times')).toBeTruthy();
  expect(screen.queryByText('Retry stale')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry current' }));
  expect(stale).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(2);
});

test('recall persists only bounded safe text, scoped to its Station, with no replayable actions', () => {
  const action = vi.fn();
  for (let index = 0; index < 55; index++)
    toastStore.upsert({
      message: `raw secret ${index}`,
      recallText: `Safe summary ${index} ${'x'.repeat(600)}`,
      duration: 0,
      detail: 'sensitive diagnostic',
      sessionId: 'private-thread',
      actions: [{ label: 'Do not save', onClick: action }],
    });
  const saved = localStorage.getItem('station:toast-recall:v1:station-a')!;
  expect(saved).not.toMatch(
    /raw secret|sensitive diagnostic|private-thread|Do not save|onClick/,
  );
  const entries = JSON.parse(saved) as Array<{ message: string }>;
  expect(entries).toHaveLength(50);
  expect(entries.every((entry) => entry.message.length <= 500)).toBe(true);
  toastStore.bindScope('station-b');
  expect(toastStore.getHistorySnapshot()).toHaveLength(0);
  expect(
    toastStore.upsert({
      message: 'Late Station A result',
      stationScope: 'station-a',
    }),
  ).toBe('');
  toastStore.bindScope('station-a');
  expect(toastStore.getSnapshot()).toHaveLength(0);
  expect(toastStore.getHistorySnapshot()).toHaveLength(50);
  expect(
    toastStore
      .getHistorySnapshot()
      .every(
        (entry) =>
          entry.dismissed &&
          !entry.actions &&
          !entry.metadata &&
          !entry.sessionId,
      ),
  ).toBe(true);
  toastStore.runAction(toastStore.getHistorySnapshot()[0]!.id, 0);
  expect(action).not.toHaveBeenCalled();
  toastStore.clearRecentMessages();
  expect(
    JSON.parse(localStorage.getItem('station:toast-recall:v1:station-a')!),
  ).toEqual([]);
});

test('approval requests remain durable under transient traffic and clear by request identity', () => {
  toastStore.showToolApproval({
    sessionId: 'chat-a',
    requestId: 'request-a',
    toolName: 'Bash',
    agentName: 'Agent',
    actions: [],
  });
  for (let index = 0; index < 110; index++) toastStore.show(`notice ${index}`);
  mount();
  advance(60000);
  expect(
    screen.getByRole('button', { name: '1 pending approval' }),
  ).toBeTruthy();
  act(() => toastStore.dismissApprovalRequest('chat-a', 'request-a'));
  expect(
    screen.queryByRole('button', { name: '1 pending approval' }),
  ).toBeNull();
});

test('keyboard activation of a nested action cannot navigate the card behind it', async () => {
  const navigate = vi.fn();
  toastStore.showTurnActivity({
    sessionId: 'background-chat',
    message: 'Needs attention',
    conversationTitle: 'Background work',
    failed: true,
    onNavigate: navigate,
  });
  mount();
  const open = screen.getByRole('button', { name: 'Open' });
  fireEvent.keyDown(open, { key: 'Enter' });
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(open);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Needs attention')).toBeNull();
});
