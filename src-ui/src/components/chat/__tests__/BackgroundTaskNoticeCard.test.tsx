/** @vitest-environment jsdom */
/**
 * A background task's settle notice, end to end on the client: the real
 * child-work handler announces into a real store, and the stored notice is
 * rendered through `EphemeralMessage`, the component the dock's transcript
 * renders every ephemeral notice with.
 */
import type { ChildWorkDelta } from '@kontourai/station-contracts/child-work';
import { cleanup, render, screen, within } from '@testing-library/react';
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
): ChildWorkDelta {
  return {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: threadId,
    childId,
    status,
    result: { summary },
    identity: { ...(title ? { title } : {}), backgrounded: true },
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
  return within(view.container).getByTestId('background-task-notice');
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

describe('background task settle notice', () => {
  test('a finished task shows its title once, with the restating summary behind Details', async () => {
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

    expect(within(card).getByText('Task finished')).toBeTruthy();
    // The title is the line's; the summary that repeats it is folded away.
    const details = card.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(
      within(details!).getByText(/completed \(exit code 0\)/),
    ).toBeTruthy();
    const outsideDetails = [...card.querySelectorAll('.task-notice__line')]
      .map((line) => line.textContent ?? '')
      .join('');
    expect(outsideDetails.split(title)).toHaveLength(2);
  });

  test('success and failure carry different status text and tone', async () => {
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
    const finishedStatus = within(finishedCard).getByText('Task finished');
    cleanup();
    const failedCard = await renderNotice(failed!);
    const failedStatus = within(failedCard).getByText('Task failed');

    expect(finishedStatus.className).toContain('task-notice__status--success');
    expect(failedStatus.className).toContain('task-notice__status--danger');
    // The glyph is decoration; the words carry the status.
    expect(
      failedStatus
        .querySelector('.task-notice__glyph')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('a stopped task says so in words and draws no emoji', async () => {
    handlers.applyChildWorkToChat(threadId, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: threadId,
      childId: 'stopped',
      status: 'cancelled',
      result: { handle: { kind: 'transcript-file', path: '/tmp/a.jsonl' } },
      identity: { title: 'List open issues', backgrounded: true },
    });
    const [notice] = storedNotices();
    const card = await renderNotice(notice!);
    expect(within(card).getByText('Task stopped')).toBeTruthy();
    expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    // No result summary was reported, so nothing repeats the title.
    expect(card.textContent?.split('List open issues')).toHaveLength(2);
  });

  test("a subagent's own report stays visible inline", async () => {
    handlers.applyChildWorkToChat(
      threadId,
      settle('agent', 'completed', 'Research', 'Found the regression in #12.'),
    );
    const card = await renderNotice(storedNotices()[0]!);
    expect(card.querySelector('details')).toBeNull();
    expect(
      within(card).getByText(/Found the regression in #12\./),
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
