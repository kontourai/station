/** @vitest-environment jsdom */
/**
 * A background task's settle notice, end to end on the client: the real
 * child-work handler announces into a real store, and the stored notice is
 * rendered through `EphemeralMessage`, the component the dock's transcript
 * renders every ephemeral notice with.
 */
import type {
  ChildWorkDelta,
  ChildWorkKind,
} from '@kontourai/station-contracts/child-work';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EphemeralMessage as StoredNotice } from '../../../contexts/active-chats-state';

import { activeChatsStore } from '../../../contexts/active-chats-store';
import * as handlers from '../../../hooks/orchestration/childWorkHandlers';

vi.mock('../../../contexts/active-chats-store', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../contexts/active-chats-store')
    >();
  return {
    ...actual,
    activeChatsStore: new actual.ActiveChatsStore({
      storage: { getItem: () => null, setItem: () => {} },
    }),
  };
});

const threadId = 'thread-notice-1';

/** The settle a Claude backgrounded Bash produces (see the adapter fixture
 * `claude-2.1.281-background-bash.jsonl`): its summary quotes the title. */
function settle(
  childId: string,
  status: Extract<ChildWorkDelta, { kind: 'settle' }>['status'],
  title: string | undefined,
  summary: string,
  workKind: ChildWorkKind = 'command',
): ChildWorkDelta {
  return {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: threadId,
    childId,
    status,
    result: { summary },
    identity: { ...(title ? { title } : {}), backgrounded: true, workKind },
  };
}

function storedNotices(): StoredNotice[] {
  return activeChatsStore.getSnapshot()[threadId]?.ephemeralMessages ?? [];
}

async function renderNotice(notice: StoredNotice) {
  const { EphemeralMessage } = await import('../EphemeralMessage');
  const view = render(
    <EphemeralMessage
      msg={notice}
      idx={0}
      fontSize={14}
      isRemoving={false}
      onDismiss={() => {}}
    />,
  );
  expect(
    within(view.container).queryByTestId('background-task-notice'),
  ).toBeNull();
  return within(view.container).getByTestId('subagent-card');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  activeChatsStore.initChat(threadId, {
    agentSlug: 'claude-agent',
    agentName: 'Claude',
    title: 'Claude Chat',
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(threadId);
  activeChatsStore.flushPendingSave();
  vi.unstubAllGlobals();
});

describe('background task settlement in the shared disclosure', () => {
  test('a finished command names its title once and retains its result in the expander', async () => {
    const title = 'Capture the mismatch screen once';
    handlers.applyChildWorkToChat(
      threadId,
      settle(
        'bg-1',
        'completed',
        title,
        `Background command "${title}" completed (exit code 0)`,
      ),
    );
    const [notice] = storedNotices();
    expect(notice).toBeDefined();
    const card = await renderNotice(notice!);
    const toggle = within(card).getByRole('button', {
      name: new RegExp(title),
    });

    expect(within(card).getByText('Run finished')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(card.textContent?.split(title)).toHaveLength(2);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await within(card).findByText('Exit code 0')).toBeTruthy();
    expect(card.textContent?.split(title)).toHaveLength(2);
  });

  test('success and failure retain distinct observed states and words', async () => {
    const title = 'Capture the screen five times and save images';
    handlers.applyChildWorkToChat(
      threadId,
      settle('ok', 'completed', 'Quick check', 'All clear.'),
    );
    handlers.applyChildWorkToChat(
      threadId,
      settle(
        'bad',
        'failed',
        title,
        `Background command "${title}" failed with exit code 1`,
      ),
    );
    const [finished, failed] = storedNotices();
    const finishedCard = await renderNotice(finished!);
    expect(within(finishedCard).getByText('Run finished')).toBeTruthy();
    expect(finishedCard.getAttribute('data-status')).toBe('completed');
    cleanup();
    const failedCard = await renderNotice(failed!);
    expect(within(failedCard).getByText('Failed')).toBeTruthy();
    expect(failedCard.getAttribute('data-status')).toBe('failed');
  });

  test('a stopped command says so in words and draws no emoji', async () => {
    handlers.applyChildWorkToChat(threadId, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: threadId,
      childId: 'stopped',
      status: 'cancelled',
      result: { handle: { kind: 'transcript-file', path: '/tmp/a.jsonl' } },
      identity: {
        title: 'List open issues',
        backgrounded: true,
        workKind: 'command',
      },
    });
    const [notice] = storedNotices();
    const card = await renderNotice(notice!);
    expect(within(card).getByText('Stopped')).toBeTruthy();
    expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(card.textContent?.split('List open issues')).toHaveLength(2);
  });

  test("a subagent's own report stays visible in the collapsed preview", async () => {
    handlers.applyChildWorkToChat(
      threadId,
      settle(
        'agent',
        'completed',
        'Research',
        'Research found the regression in #12.',
        'agent',
      ),
    );
    const card = await renderNotice(storedNotices()[0]!);
    expect(
      within(card)
        .getByRole('button', { name: /^Research/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      within(card).getByText(/Research found the regression in #12\./),
    ).toBeTruthy();
  });

  test('a notice without the structured field still renders its text', async () => {
    const { EphemeralMessage } = await import('../EphemeralMessage');
    const view = render(
      <EphemeralMessage
        msg={{ content: 'Plain notice' }}
        idx={0}
        fontSize={14}
        isRemoving={false}
        onDismiss={() => {}}
      />,
    );
    expect(view.queryByTestId('background-task-notice')).toBeNull();
    expect(screen.getByText('Plain notice')).toBeTruthy();
  });
});
