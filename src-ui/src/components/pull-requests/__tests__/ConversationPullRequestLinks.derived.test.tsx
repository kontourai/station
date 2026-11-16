// @vitest-environment jsdom

import type { PullRequestFeedbackView } from '@kontourai/station-contracts/pull-request-feedback';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * A pull request Station found on the chat's Task branch: its row reads
 * "from this Task's branch", carries Agent feedback… only when no linked or
 * Task-kept row for the same pull request comes first, and offers "Remove
 * from this chat", which asks first and then removes it for good.
 */

const PR = (ref: string) => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref,
});
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
const flags = vi.hoisted(() => ({ preview: true }));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(flags.preview ? ['pull-request-agent-feedback'] : []),
}));

const links = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: (...args: unknown[]) => {
    links.read(...args);
    const row = (ref: string, source: string, title: string) => ({
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'acme', name: 'widgets' },
      ref,
      source,
      observedAt: '2026-11-16T12:00:00Z',
      status: { state: 'current', title, pullRequestState: 'OPEN' },
    });
    return Promise.resolve({
      conversationId: 'c1',
      observedAt: '2026-11-16T12:00:00Z',
      links: [
        row('42', 'explicit', 'Linked by hand'),
        row('42', 'branch-derived', 'Linked by hand'),
        row('43', 'branch-derived', 'Opened by the Task'),
      ],
    });
  },
  linkConversationPullRequest: vi.fn(),
  unlinkConversationPullRequest: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', () => {
  const view = (ref: string): PullRequestFeedbackView => ({
    identity: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'acme', name: 'widgets' },
      ref,
    },
    ownedHere: true,
    owner: { conversationId: 'c1' },
    settings: {
      fixFailingChecks: true,
      addressReviewComments: true,
      reviewEachHead: false,
    },
    status: { state: 'watching' },
    history: [],
  });
  return {
    pullRequestFeedbackOwnerOf: () => undefined,
    readPullRequestFeedbackCapability: vi.fn(async () => true),
    getConversationPullRequestFeedback: () =>
      Promise.resolve({
        conversationId: 'c1',
        pullRequests: [view('42'), view('43')],
      }),
    writePullRequestFeedback: vi.fn(),
    sendPullRequestFeedbackAgain: vi.fn(),
    turnOffPullRequestFeedback: vi.fn(),
    removeDerivedPullRequest: (...args: unknown[]) =>
      sdk.remove(...(args as [])),
  };
});

import { ConversationPullRequestLinks } from '../ConversationPullRequestLinks';

function renderLinks() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationPullRequestLinks conversationId="c1" />
    </QueryClientProvider>,
  );
}

async function menuOf(rowIndex: number, reference: string) {
  await screen.findByText('Opened by the Task');
  // The feedback read answers after the links: let it land.
  await act(async () => {});
  await waitFor(() =>
    expect(screen.getAllByText('Auto-fix on').length).toBe(2),
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: `More actions for ${reference}` })[
      rowIndex
    ]!,
  );
  return screen.findByRole('menu');
}

beforeEach(() => {
  flags.preview = true;
  sdk.remove.mockClear();
  links.read.mockClear();
});
afterEach(cleanup);

describe('a pull request from the Task branch', () => {
  test("reads as from this Task's branch", async () => {
    renderLinks();
    await screen.findByText('Opened by the Task');
    expect(screen.getAllByText("from this Task's branch")).toHaveLength(2);
  });

  test('Agent feedback goes on the first row for a pull request only', async () => {
    renderLinks();
    const linked = await menuOf(0, 'github.com/acme/widgets #42');
    expect(
      within(linked).getByRole('menuitem', { name: 'Agent feedback…' }),
    ).toBeTruthy();
    expect(
      within(linked).getByRole('menuitem', { name: 'Unlink' }),
    ).toBeTruthy();
    fireEvent.keyDown(linked, { key: 'Escape' });
    const derivedDuplicate = await menuOf(1, 'github.com/acme/widgets #42');
    expect(
      within(derivedDuplicate).queryByRole('menuitem', {
        name: 'Agent feedback…',
      }),
    ).toBeNull();
    expect(
      within(derivedDuplicate).getByRole('menuitem', {
        name: 'Remove from this chat',
      }),
    ).toBeTruthy();
    fireEvent.keyDown(derivedDuplicate, { key: 'Escape' });
    const derivedOnly = await menuOf(0, 'github.com/acme/widgets #43');
    expect(
      within(derivedOnly).getByRole('menuitem', { name: 'Agent feedback…' }),
    ).toBeTruthy();
  });

  test('Remove from this chat asks first, then removes it and reads the list again', async () => {
    renderLinks();
    const menu = await menuOf(0, 'github.com/acme/widgets #43');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Remove from this chat' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove from this chat',
    });
    expect(confirm.textContent).toContain("It won't come back for this Task.");
    expect(sdk.remove).not.toHaveBeenCalled();
    const reads = links.read.mock.calls.length;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sdk.remove).toHaveBeenCalledWith(
        'http://station.test',
        'c1',
        PR('43'),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(links.read.mock.calls.length).toBeGreaterThan(reads),
    );
  });

  test('offers no removal while agent feedback is off', async () => {
    flags.preview = false;
    renderLinks();
    await screen.findByText('Opened by the Task');
    // A derived row has nothing else to offer: no overflow at all.
    expect(
      screen.queryByRole('button', {
        name: 'More actions for github.com/acme/widgets #43',
      }),
    ).toBeNull();
    expect(screen.queryByText('Remove from this chat')).toBeNull();
  });
});
